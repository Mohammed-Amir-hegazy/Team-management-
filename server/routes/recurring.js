'use strict';

// Recurring follow-ups: some projects need checking every so often. A follow-up names the person
// responsible and how often; on each due date the platform creates a task for them in the project (with
// an alarm at the due time and a deadline a few days later) and moves the date on to the next period.
//
// Due follow-ups are created by the scheduler and, since a serverless host may not keep it running, also
// whenever people are using the platform (see runRecurringSoon). Each period is claimed by moving its
// date first, so two servers never create the same task.

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const {
  loadProject, canManageProject, isSelfOrBelow, getUser, notify, PRIORITIES,
} = require('../access');
const { createTask } = require('./tasks');

const UNITS = { day: ['يوم', 'أيام'], week: ['أسبوع', 'أسابيع'], month: ['شهر', 'أشهر'] };

// "كل أسبوع" / "كل 3 أسابيع" …
function everyLabel(n, unit) {
  const [one, many] = UNITS[unit];
  if (n === 1) return `كل ${one}`;
  if (n === 2) return { day: 'كل يومين', week: 'كل أسبوعين', month: 'كل شهرين' }[unit];
  return `كل ${n} ${n <= 10 ? many : one}`;
}

// One period later; months keep the day of the month (the 31st becomes the month's last day).
function advance(iso, n, unit) {
  const d = new Date(iso);
  if (unit === 'day') d.setUTCDate(d.getUTCDate() + n);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * n);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString();
}

function readSchedule(body, current = {}) {
  const pick = (k) => (body[k] !== undefined ? body[k] : current[k]);
  const everyN = Number(pick('every_n'));
  if (!Number.isInteger(everyN) || everyN < 1 || everyN > 365) throw new HttpError(400, 'يُرجى تحديد كل كم يومًا أو أسبوعًا أو شهرًا (من 1 إلى 365)');
  const durationDays = Number(pick('duration_days') ?? 1);
  if (!Number.isInteger(durationDays) || durationDays < 0 || durationDays > 90) throw new HttpError(400, 'مدة التنفيذ تكون من 0 إلى 90 يومًا');
  return {
    title: v.text(pick('title'), 'عنوان المتابعة', { max: 300 }),
    description: v.text(pick('description') || '', 'الوصف', { required: false, max: 10000 }),
    priority: v.oneOf(pick('priority') || 'medium', PRIORITIES, 'الأولوية'),
    every_n: everyN,
    unit: v.oneOf(pick('unit'), Object.keys(UNITS), 'الوحدة'),
    duration_days: durationDays,
  };
}

const SELECT = `
  SELECT r.*, u.name AS assignee_name, c.name AS creator_name, t.status AS last_task_status
  FROM recurring_tasks r JOIN users u ON u.id = r.assignee_id JOIN users c ON c.id = r.created_by
  LEFT JOIN tasks t ON t.id = r.last_task_id`;

const withLabel = (r) => ({ ...r, every_label: everyLabel(r.every_n, r.unit), active: !!r.active });

async function loadSchedule(db, user, id) {
  const row = await db.get('SELECT * FROM recurring_tasks WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'المتابعة غير موجودة');
  const project = await loadProject(db, user, row.project_id);
  // The project's manager, whoever set it up, or anyone above the person responsible.
  const allowed = canManageProject(user, project) || row.created_by === user.id
    || (row.assignee_id !== user.id && await isSelfOrBelow(db, user, row.assignee_id));
  return { row, project, allowed };
}

// Creates the task for every follow-up that has come due. Missed periods (the platform was asleep)
// produce one task, not a pile of them.
async function runRecurring(db, at = new Date()) {
  const ts = at.toISOString();
  const due = await db.all('SELECT * FROM recurring_tasks WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 50', ts);
  let created = 0;
  for (const r of due) {
    let next = advance(r.next_run_at, r.every_n, r.unit);
    while (next <= ts) next = advance(next, r.every_n, r.unit);
    const claim = await db.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ? AND next_run_at = ? AND active = 1', next, r.id, r.next_run_at);
    if (!claim.changes) continue;
    const creator = await getUser(db, r.created_by);
    const project = await db.get('SELECT * FROM projects WHERE id = ?', r.project_id);
    // The occasion is when it came due (or now, if that was missed); the deadline follows it.
    const occasion = r.next_run_at < new Date(at.getTime() - 3600e3).toISOString() ? ts : r.next_run_at;
    const deadline = new Date(new Date(occasion).getTime() + r.duration_days * 864e5).toISOString();
    try {
      if (!creator || !creator.active || !project) throw new HttpError(400, 'unavailable');
      const { task } = await createTask(db, creator, project, {
        title: r.title, description: r.description, priority: r.priority, assignee_id: r.assignee_id,
        reminder_at: occasion, deadline,
      }, { silent: true, recurringId: r.id });
      await db.run('UPDATE recurring_tasks SET last_task_id = ?, runs = runs + 1 WHERE id = ?', task.id, r.id);
      await notify(db, r.assignee_id, 'reminder', `🔁 حان موعد المتابعة الدورية «${r.title}» في مشروع «${project.name}»`, `#/tasks/${task.id}`);
      created++;
    } catch (err) {
      // The person can no longer be given tasks by whoever set it up: pause it and say so.
      await db.run('UPDATE recurring_tasks SET active = 0 WHERE id = ?', r.id);
      if (creator && creator.active) {
        await notify(db, creator.id, 'task', `أُوقفت المتابعة الدورية «${r.title}» لتعذّر إنشاء مهمتها؛ يُرجى مراجعة المسؤول عنها`, `#/projects/${r.project_id}`);
      }
      if (!(err instanceof HttpError)) console.error('recurring follow-up:', err);
    }
  }
  return created;
}

// While people use the platform, due follow-ups are created at most once a minute per server.
let lastRun = 0;
function runRecurringSoon(db) {
  if (Date.now() - lastRun < 60000) return;
  lastRun = Date.now();
  runRecurring(db).catch((err) => console.error('recurring follow-ups:', err.message));
}

function register(router) {
  router.get('/api/projects/:id/recurring', async ({ db, user, params }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    const rows = await db.all(`${SELECT} WHERE r.project_id = ? ORDER BY r.active DESC, r.next_run_at`, project.id);
    return { recurring: rows.map(withLabel) };
  });

  router.post('/api/projects/:id/recurring', async ({ db, user, params, body }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    if (project.personal_owner_id) throw new HttpError(400, 'تُضاف المتابعات الدورية إلى المشاريع فقط');
    const s = readSchedule(body);
    const assigneeId = v.id(body.assignee_id ?? user.id, 'المسؤول عن المتابعة');
    if (!(await isSelfOrBelow(db, user, assigneeId))) throw new HttpError(403, 'يمكنك إسناد المتابعة إلى نفسك أو إلى أحد أعضاء فريقك فقط');
    const assignee = await getUser(db, assigneeId);
    if (!assignee || !assignee.active) throw new HttpError(404, 'المستخدم غير موجود');
    const first = v.optionalDate(body.next_run_at, 'موعد أول متابعة');
    if (!first) throw new HttpError(400, 'يُرجى تحديد موعد أول متابعة');
    const r = await db.run(`INSERT INTO recurring_tasks (company_id, project_id, created_by, assignee_id, title, description, priority,
      every_n, unit, duration_days, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    user.company_id, project.id, user.id, assigneeId, s.title, s.description, s.priority, s.every_n, s.unit, s.duration_days, first, now());
    if (assigneeId !== user.id) {
      await notify(db, assigneeId, 'task', `أُسندت إليك متابعة دورية «${s.title}» ${everyLabel(s.every_n, s.unit)} في مشروع «${project.name}»`, `#/projects/${project.id}`);
    }
    // A first date already reached is created straight away.
    await runRecurring(db);
    return { recurring: withLabel(await db.get(`${SELECT} WHERE r.id = ?`, r.lastInsertRowid)) };
  });

  router.patch('/api/recurring/:id', async ({ db, user, params, body }) => {
    const { row, allowed } = await loadSchedule(db, user, v.id(params.id, 'المتابعة'));
    if (!allowed) throw new HttpError(403, 'ليست لديك صلاحية لتعديل هذه المتابعة');
    const s = readSchedule(body, row);
    let assigneeId = row.assignee_id;
    if (body.assignee_id !== undefined) {
      assigneeId = v.id(body.assignee_id, 'المسؤول عن المتابعة');
      if (!(await isSelfOrBelow(db, user, assigneeId))) throw new HttpError(403, 'يمكنك إسناد المتابعة إلى نفسك أو إلى أحد أعضاء فريقك فقط');
    }
    const next = body.next_run_at !== undefined ? v.optionalDate(body.next_run_at, 'موعد المتابعة القادمة') || row.next_run_at : row.next_run_at;
    const active = body.active !== undefined ? (body.active ? 1 : 0) : row.active;
    // Whoever changes it takes over creating its tasks (their right to assign was just checked).
    await db.run(`UPDATE recurring_tasks SET title = ?, description = ?, priority = ?, every_n = ?, unit = ?, duration_days = ?,
      assignee_id = ?, next_run_at = ?, active = ?, created_by = ? WHERE id = ?`,
    s.title, s.description, s.priority, s.every_n, s.unit, s.duration_days, assigneeId, next, active, user.id, row.id);
    if (active) await runRecurring(db);
    return { recurring: withLabel(await db.get(`${SELECT} WHERE r.id = ?`, row.id)) };
  });

  router.delete('/api/recurring/:id', async ({ db, user, params }) => {
    const { row, allowed } = await loadSchedule(db, user, v.id(params.id, 'المتابعة'));
    if (!allowed) throw new HttpError(403, 'ليست لديك صلاحية لحذف هذه المتابعة');
    // Tasks already created stay; only future ones stop.
    await db.run('UPDATE tasks SET recurring_id = NULL WHERE recurring_id = ?', row.id);
    await db.run('DELETE FROM recurring_tasks WHERE id = ?', row.id);
    return { ok: true };
  });
}

module.exports = register;
module.exports.runRecurring = runRecurring;
module.exports.runRecurringSoon = runRecurringSoon;
module.exports.advance = advance;
module.exports.everyLabel = everyLabel;
