'use strict';

// Recurring follow-ups: some projects need checking every so often. A follow-up names the person
// responsible and how often; its next occurrence is always waiting in their tasks as a scheduled task
// (alarm on the date, deadline a few days later), and its result is sent as a report with photos.
//
// Due follow-ups are created by the scheduler and, since a serverless host may not keep it running, also
// whenever people are using the platform (see runRecurringSoon). Each period is claimed by moving its
// date first, so two servers never create the same task.

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const {
  loadProject, canManageProject, isSelfOrBelow, getUser, notify, purgeTasks, PRIORITIES,
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
  SELECT r.*, u.name AS assignee_name, c.name AS creator_name, t.status AS last_task_status, t.reminder_at AS last_task_at,
         (SELECT x.id FROM reports x JOIN tasks y ON y.id = x.task_id WHERE y.recurring_id = r.id ORDER BY x.id DESC LIMIT 1) AS last_report_id
  FROM recurring_tasks r JOIN users u ON u.id = r.assignee_id JOIN users c ON c.id = r.created_by
  LEFT JOIN tasks t ON t.id = r.last_task_id`;

const withLabel = (r) => ({ ...r, every_label: everyLabel(r.every_n, r.unit), active: !!r.active });

// The next occurrence already waiting as a task, if nobody has touched it yet (not started, alarm not
// rung): removed when its follow-up is changed, paused or deleted. Returns its date so it can be kept.
async function withdrawUpcoming(db, row) {
  if (!row.last_task_id) return null;
  const t = await db.get(`SELECT * FROM tasks WHERE id = ? AND recurring_id = ? AND status = 'todo' AND reminder_sent = 0
    AND reminder_at > ?`, row.last_task_id, row.id, now());
  if (!t) return null;
  await purgeTasks(db, 'SELECT id FROM tasks WHERE id = ?', t.id);
  await db.run('UPDATE recurring_tasks SET last_task_id = NULL, runs = MAX(runs - 1, 0) WHERE id = ?', row.id);
  return t.reminder_at;
}

async function loadSchedule(db, user, id) {
  const row = await db.get('SELECT * FROM recurring_tasks WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'المتابعة غير موجودة');
  const project = await loadProject(db, user, row.project_id);
  // The project's manager, whoever set it up, or anyone above the person responsible.
  const allowed = canManageProject(user, project) || row.created_by === user.id
    || (row.assignee_id !== user.id && await isSelfOrBelow(db, user, row.assignee_id));
  return { row, project, allowed };
}

const dateLabel = (iso) => new Intl.DateTimeFormat('ar-EG', {
  timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short', numberingSystem: 'latn',
}).format(new Date(iso));

// Keeps every follow-up's next occurrence scheduled as a task: it is created up to one period ahead
// (so the person sees it coming in their tasks), its alarm rings on the date, and once that date
// arrives the following occurrence is scheduled. Dates that passed while nobody used the platform
// are skipped rather than piled up.
async function runRecurring(db, at = new Date()) {
  const ts = at.toISOString();
  const grace = new Date(at.getTime() - 3600e3).toISOString();
  const rows = await db.all('SELECT * FROM recurring_tasks WHERE active = 1 ORDER BY next_run_at LIMIT 500');
  let created = 0;
  for (const row of rows) {
    let current = row.next_run_at;
    for (let i = 0; i < 3; i++) {
      let date = current;
      while (date < grace) date = advance(date, row.every_n, row.unit);
      if (date > advance(ts, row.every_n, row.unit)) {
        // Not within a period yet; still drop dates that were skipped.
        if (date !== current) await db.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ? AND next_run_at = ?', date, row.id, current);
        break;
      }
      const next = advance(date, row.every_n, row.unit);
      const claim = await db.run('UPDATE recurring_tasks SET next_run_at = ? WHERE id = ? AND next_run_at = ? AND active = 1', next, row.id, current);
      if (!claim.changes) break;
      current = next;
      const creator = await getUser(db, row.created_by);
      const project = await db.get('SELECT * FROM projects WHERE id = ?', row.project_id);
      try {
        if (!creator || !creator.active || !project) throw new HttpError(400, 'unavailable');
        const { task } = await createTask(db, creator, project, {
          title: row.title, description: row.description, priority: row.priority, assignee_id: row.assignee_id,
          reminder_at: date, deadline: new Date(Date.parse(date) + row.duration_days * 864e5).toISOString(),
        }, { silent: true, recurringId: row.id });
        await db.run('UPDATE recurring_tasks SET last_task_id = ?, runs = runs + 1 WHERE id = ?', task.id, row.id);
        await notify(db, row.assignee_id, 'task',
          `📅 جُدولت لك المتابعة الدورية «${row.title}» في مشروع «${project.name}» بتاريخ ${dateLabel(date)}`, `#/tasks/${task.id}`);
        created++;
      } catch (err) {
        // The person can no longer be given tasks by whoever set it up: pause it and say so.
        await db.run('UPDATE recurring_tasks SET active = 0 WHERE id = ?', row.id);
        if (creator && creator.active) {
          await notify(db, creator.id, 'task', `أُوقفت المتابعة الدورية «${row.title}» لتعذّر إنشاء مهمتها؛ يُرجى مراجعة المسؤول عنها`, `#/projects/${row.project_id}`);
        }
        if (!(err instanceof HttpError)) console.error('recurring follow-up:', err);
        break;
      }
    }
  }
  return created;
}

// While people use the platform, due follow-ups (and task alarms) run at most once a minute per server.
let lastRun = 0;
// Task alarms too: a serverless host may not keep the scheduler's timer running.
function runRecurringSoon(db) {
  if (Date.now() - lastRun < 60000) return;
  lastRun = Date.now();
  const { runReminders } = require('../scheduler');
  runRecurring(db)
    .then(() => runReminders(db))
    .catch((err) => console.error('recurring follow-ups / alarms:', err.message));
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
    // Its first occurrence is scheduled at once when it falls within one period; otherwise the person
    // is told now and sees the task when it comes closer.
    await runRecurring(db);
    const saved = await db.get('SELECT runs FROM recurring_tasks WHERE id = ?', r.lastInsertRowid);
    if (!saved.runs && assigneeId !== user.id) {
      await notify(db, assigneeId, 'task', `أُسندت إليك متابعة دورية «${s.title}» ${everyLabel(s.every_n, s.unit)} في مشروع «${project.name}»`, `#/projects/${project.id}`);
    }
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
    const active = body.active !== undefined ? (body.active ? 1 : 0) : row.active;
    // A scheduled, untouched occurrence is re-made to match the new settings (or withdrawn while paused).
    const upcoming = await withdrawUpcoming(db, row);
    const asked = body.next_run_at !== undefined ? v.optionalDate(body.next_run_at, 'موعد المتابعة القادمة') : null;
    const next = asked || upcoming || row.next_run_at;
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
    // Tasks already worked on stay; the untouched upcoming one goes with it.
    await withdrawUpcoming(db, row);
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
