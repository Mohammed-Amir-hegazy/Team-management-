'use strict';

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const {
  requireSupervisor, subordinateIds, loadProject, loadTask, notify, publicUser, roleRank,
} = require('../access');
const {
  TASK_FIELDS, TASK_FROM, placeholders, markOverdue, summarize, memberStats, workSnapshot, EMPTY_STATS,
} = require('../snapshot');
const { validateImages } = require('../images');

function reportImages(db, reportId) {
  return db.all('SELECT id, url, caption, width, height FROM attachments WHERE report_id = ? ORDER BY id', reportId);
}

const NOT_ALLOWED = 'ليست لديك صلاحية لتنفيذ هذا الإجراء';

const REPORT_SQL = `
  SELECT r.*, s.name AS sender_name, s.job_title AS sender_job_title, s.company_id AS sender_company_id, x.name AS recipient_name,
         CASE WHEN p.personal_owner_id IS NULL THEN p.name ELSE 'مهمة مستقلة' END AS project_name, t.title AS task_title
  FROM reports r
  JOIN users s ON s.id = r.sender_id
  JOIN users x ON x.id = r.recipient_id
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN tasks t ON t.id = r.task_id
`;

function parseSnapshot(report) {
  if (!report) return report;
  let snapshot = null;
  try { snapshot = report.snapshot ? JSON.parse(report.snapshot) : null; } catch { snapshot = null; }
  return { ...report, snapshot };
}

// Lists stay light: only the headline numbers of the attached work status.
function listItem(report) {
  const { snapshot, ...rest } = parseSnapshot(report);
  return { ...rest, status_summary: snapshot ? snapshot.summary : null };
}

// Sender and recipient can act on a report; anyone above the sender (and the owner) may read it.
async function loadReport(db, user, reportId) {
  const report = await db.get(`${REPORT_SQL} WHERE r.id = ?`, reportId);
  const involved = report && (report.sender_id === user.id || report.recipient_id === user.id);
  if (!report || (!involved && !(user.role === 'owner' && report.sender_company_id === user.company_id)
    && !(await subordinateIds(db, user.id)).has(report.sender_id))) {
    throw new HttpError(404, 'التقرير غير موجود');
  }
  return report;
}

function periodFrom(query) {
  const to = query.get('to') ? new Date(query.get('to')) : new Date();
  const from = query.get('from') ? new Date(query.get('from')) : new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new HttpError(400, 'الفترة الزمنية المحددة غير صحيحة');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

module.exports = function register(router) {
  // box: inbox (sent to me), sent (by me), team (sent by anyone below me, read-only).
  router.get('/api/reports', async ({ db, user, query }) => {
    const box = query.get('box');
    if (box === 'team') {
      const team = [...(await subordinateIds(db, user.id))];
      if (!team.length) return { reports: [] };
      const rows = await db.all(`${REPORT_SQL} WHERE r.sender_id IN (${placeholders(team)}) AND r.forwarded_from_id IS NULL
        ORDER BY r.created_at DESC LIMIT 200`, ...team);
      return { reports: rows.map(listItem) };
    }
    const column = box === 'sent' ? 'r.sender_id' : 'r.recipient_id';
    const rows = await db.all(`${REPORT_SQL} WHERE ${column} = ? ORDER BY r.created_at DESC LIMIT 200`, user.id);
    return { reports: rows.map(listItem) };
  });

  // What will be attached, so the sender can see it before sending.
  router.get('/api/reports/preview', async ({ db, user, query }) => {
    const taskId = v.optionalId(query.get('task_id'), 'المهمة');
    let projectId = v.optionalId(query.get('project_id'), 'المشروع');
    if (taskId) projectId = (await loadTask(db, user, taskId)).task.project_id;
    else if (projectId) await loadProject(db, user, projectId);
    return { snapshot: await workSnapshot(db, user, { projectId, taskId }) };
  });

  // The recipient is always the sender's direct supervisor: no level can be skipped.
  router.post('/api/reports', async ({ db, user, body, config }) => {
    const supervisor = await requireSupervisor(db, user);
    if (body.recipient_id !== undefined && body.recipient_id !== null && Number(body.recipient_id) !== supervisor.id) {
      throw new HttpError(403, 'تُرسل التقارير إلى المسؤول المباشر فقط');
    }
    const title = v.text(body.title, 'عنوان التقرير', { max: 300 });
    const text = v.text(body.body, 'نص التقرير', { max: 20000 });
    let projectId = v.optionalId(body.project_id, 'المشروع');
    const taskId = v.optionalId(body.task_id, 'المهمة');
    if (taskId) projectId = (await loadTask(db, user, taskId)).task.project_id;
    else if (projectId) await loadProject(db, user, projectId);
    const snapshot = body.include_status === false ? null
      : JSON.stringify(await workSnapshot(db, user, { projectId, taskId }));
    const images = Array.isArray(body.images) && body.images.length ? await validateImages(db, config, user, body.images) : [];

    const id = await db.transaction(async (tx) => {
      const r = await tx.run(`
        INSERT INTO reports (sender_id, recipient_id, title, body, project_id, task_id, snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, user.id, supervisor.id, title, text, projectId, taskId, snapshot, now());
      for (const img of images) {
        await tx.run(`INSERT INTO attachments (report_id, uploaded_by, url, public_id, width, height, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, r.lastInsertRowid, user.id, img.url, img.public_id, img.width, img.height, now());
      }
      await notify(tx, supervisor.id, 'report', `تقرير جديد من ${user.name}: «${title}»`, `#/reports/${r.lastInsertRowid}`);
      return r.lastInsertRowid;
    });
    return { report: parseSnapshot(await db.get(`${REPORT_SQL} WHERE r.id = ?`, id)) };
  });

  router.get('/api/reports/:id', async ({ db, user, params }) => {
    const report = await loadReport(db, user, v.id(params.id, 'التقرير'));
    if (report.recipient_id === user.id && !report.read_at) {
      report.read_at = now();
      await db.run('UPDATE reports SET read_at = ? WHERE id = ?', report.read_at, report.id);
    }
    const forwardedFrom = report.forwarded_from_id
      ? await db.get(`${REPORT_SQL} WHERE r.id = ?`, report.forwarded_from_id) : null;
    const isRecipient = report.recipient_id === user.id;
    return {
      report: { ...parseSnapshot(report), images: await reportImages(db, report.id) },
      forwarded_from: forwardedFrom
        ? { ...parseSnapshot(forwardedFrom), images: await reportImages(db, forwardedFrom.id) } : null,
      permissions: {
        reply: isRecipient && !report.reply,
        forward: isRecipient && !!user.supervisor_id,
      },
    };
  });

  router.post('/api/reports/:id/reply', async ({ db, user, params, body }) => {
    const report = await loadReport(db, user, v.id(params.id, 'التقرير'));
    if (report.recipient_id !== user.id) throw new HttpError(403, NOT_ALLOWED);
    if (report.reply) throw new HttpError(400, 'تم الرد على هذا التقرير مسبقًا');
    const reply = v.text(body.reply, 'الرد', { max: 10000 });
    await db.run('UPDATE reports SET reply = ?, replied_at = ? WHERE id = ?', reply, now(), report.id);
    await notify(db, report.sender_id, 'report_reply', `ردّ ${user.name} على تقريرك «${report.title}»`, `#/reports/${report.id}`);
    return { ok: true };
  });

  // Passing a report one level up, with the forwarder's own comment on top.
  router.post('/api/reports/:id/forward', async ({ db, user, params, body }) => {
    const report = await loadReport(db, user, v.id(params.id, 'التقرير'));
    if (report.recipient_id !== user.id) throw new HttpError(403, NOT_ALLOWED);
    const supervisor = await requireSupervisor(db, user);
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 10000 });
    const title = `إحالة: ${report.title}`.slice(0, 300);
    const text = note || `تقرير مُحال من ${report.sender_name}`;
    const id = await db.transaction(async (tx) => {
      const r = await tx.run(`
        INSERT INTO reports (sender_id, recipient_id, title, body, project_id, task_id, forwarded_from_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, user.id, supervisor.id, title, text, report.project_id, report.task_id, report.id, now());
      await notify(tx, supervisor.id, 'report', `أحال إليك ${user.name} تقريرًا من ${report.sender_name}`, `#/reports/${r.lastInsertRowid}`);
      return r.lastInsertRowid;
    });
    return { report_id: id };
  });

  // Everything a leader needs about their whole team for a period, in one response:
  // per-person counters, every open task (and those completed in the period), and the team's reports.
  router.get('/api/team-report', async ({ db, user, query }) => {
    const { from, to } = periodFrom(query);
    const ids = [...(await subordinateIds(db, user.id))];
    if (!ids.length) throw new HttpError(403, 'هذا التقرير متاح لمن لديهم فريق عمل');
    const ts = now();
    const ph = placeholders(ids);

    const people = await db.all(`
      SELECT u.*, s.name AS supervisor_name FROM users u LEFT JOIN users s ON s.id = u.supervisor_id
      WHERE u.active = 1 AND u.id IN (${ph})
    `, ...ids);
    const stats = await memberStats(db, ids, { since: from });

    const tasks = markOverdue(await db.all(`
      SELECT ${TASK_FIELDS} ${TASK_FROM}
      WHERE t.assignee_id IN (${ph})
        AND (t.status != 'done' OR EXISTS (
          SELECT 1 FROM task_status_history h
          WHERE h.task_id = t.id AND h.to_status = 'done' AND h.created_at BETWEEN ? AND ?))
      ORDER BY u.name, t.status = 'done', t.deadline IS NULL, t.deadline
      LIMIT 2000
    `, ...ids, from, to), ts);

    const reports = (await db.all(`
      ${REPORT_SQL}
      WHERE r.sender_id IN (${ph}) AND r.forwarded_from_id IS NULL AND r.created_at BETWEEN ? AND ?
      ORDER BY r.created_at DESC
    `, ...ids, from, to)).map(listItem);

    const requests = await db.get(`
      SELECT COUNT(*) AS total,
        SUM(status = 'pending' OR status = 'forwarded') AS pending,
        SUM(status = 'approved') AS approved,
        SUM(status = 'rejected') AS rejected
      FROM requests WHERE sender_id IN (${ph}) AND root_id IS NULL AND created_at BETWEEN ? AND ?
    `, ...ids, from, to);

    const members = people
      .map((p) => ({ ...publicUser(p), supervisor_name: p.supervisor_name, stats: { ...EMPTY_STATS, ...(stats.get(p.id) || {}) } }))
      .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, 'ar'));

    return {
      generated_at: ts,
      generated_by: { name: user.name, job_title: user.job_title || '' },
      period: { from, to },
      totals: {
        members: members.length,
        ...summarize(tasks.filter((t) => t.status !== 'done')),
        done_in_period: members.reduce((n, m) => n + (m.stats.done_in_period || 0), 0),
        reports: reports.length,
      },
      members,
      tasks,
      reports,
      requests: { total: requests.total || 0, pending: requests.pending || 0, approved: requests.approved || 0, rejected: requests.rejected || 0 },
    };
  });
};
