'use strict';

const { HttpError } = require('../http');
const { now, transaction } = require('../db');
const v = require('../validate');
const { requireSupervisor, loadProject, loadTask, notify } = require('../access');

const REPORT_SQL = `
  SELECT r.*, s.name AS sender_name, s.role AS sender_role, x.name AS recipient_name,
         p.name AS project_name, t.title AS task_title
  FROM reports r
  JOIN users s ON s.id = r.sender_id
  JOIN users x ON x.id = r.recipient_id
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN tasks t ON t.id = r.task_id
`;

function loadReport(db, user, reportId) {
  const report = db.prepare(`${REPORT_SQL} WHERE r.id = ?`).get(reportId);
  if (!report || (report.sender_id !== user.id && report.recipient_id !== user.id)) {
    throw new HttpError(404, 'الريبورت غير موجود');
  }
  return report;
}

module.exports = function register(router) {
  router.get('/api/reports', ({ db, user, query }) => {
    const box = query.get('box') === 'sent' ? 'sent' : 'inbox';
    const column = box === 'sent' ? 'r.sender_id' : 'r.recipient_id';
    return { reports: db.prepare(`${REPORT_SQL} WHERE ${column} = ? ORDER BY r.created_at DESC`).all(user.id) };
  });

  // The recipient is always the sender's direct supervisor: nobody can skip a level.
  router.post('/api/reports', ({ db, user, body }) => {
    const supervisor = requireSupervisor(db, user);
    if (body.recipient_id !== undefined && body.recipient_id !== null && Number(body.recipient_id) !== supervisor.id) {
      throw new HttpError(403, 'الريبورت يتبعت للمسؤول المباشر عنك بس');
    }
    const title = v.text(body.title, 'عنوان الريبورت', { max: 300 });
    const text = v.text(body.body, 'محتوى الريبورت', { max: 20000 });
    let projectId = v.optionalId(body.project_id, 'المشروع');
    const taskId = v.optionalId(body.task_id, 'التاسك');
    if (taskId) projectId = loadTask(db, user, taskId).task.project_id;
    else if (projectId) loadProject(db, user, projectId);

    const id = transaction(db, () => {
      const r = db.prepare(`
        INSERT INTO reports (sender_id, recipient_id, title, body, project_id, task_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, supervisor.id, title, text, projectId, taskId, now());
      const newId = Number(r.lastInsertRowid);
      notify(db, supervisor.id, 'report', `ريبورت جديد من ${user.name}: "${title}"`, `#/reports/${newId}`);
      return newId;
    });
    return { report: db.prepare(`${REPORT_SQL} WHERE r.id = ?`).get(id) };
  });

  router.get('/api/reports/:id', ({ db, user, params }) => {
    const report = loadReport(db, user, v.id(params.id, 'الريبورت'));
    if (report.recipient_id === user.id && !report.read_at) {
      report.read_at = now();
      db.prepare('UPDATE reports SET read_at = ? WHERE id = ?').run(report.read_at, report.id);
    }
    const forwardedFrom = report.forwarded_from_id
      ? db.prepare(`${REPORT_SQL} WHERE r.id = ?`).get(report.forwarded_from_id) : null;
    return {
      report,
      forwarded_from: forwardedFrom,
      permissions: {
        reply: report.recipient_id === user.id && !report.reply,
        forward: report.recipient_id === user.id && !!user.supervisor_id,
      },
    };
  });

  router.post('/api/reports/:id/reply', ({ db, user, params, body }) => {
    const report = loadReport(db, user, v.id(params.id, 'الريبورت'));
    if (report.recipient_id !== user.id) throw new HttpError(403, 'غير مسموح');
    if (report.reply) throw new HttpError(400, 'تم الرد على هذا الريبورت بالفعل');
    const reply = v.text(body.reply, 'الرد', { max: 10000 });
    db.prepare('UPDATE reports SET reply = ?, replied_at = ? WHERE id = ?').run(reply, now(), report.id);
    notify(db, report.sender_id, 'report_reply', `${user.name} رد على ريبورت "${report.title}"`, `#/reports/${report.id}`);
    return { ok: true };
  });

  // Passing a report one level up, with the forwarder's own comment on top.
  router.post('/api/reports/:id/forward', ({ db, user, params, body }) => {
    const report = loadReport(db, user, v.id(params.id, 'الريبورت'));
    if (report.recipient_id !== user.id) throw new HttpError(403, 'غير مسموح');
    const supervisor = requireSupervisor(db, user);
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 10000 });
    const title = `تحويل: ${report.title}`.slice(0, 300);
    const text = note || `ريبورت محوّل من ${report.sender_name}`;
    const id = transaction(db, () => {
      const r = db.prepare(`
        INSERT INTO reports (sender_id, recipient_id, title, body, project_id, task_id, forwarded_from_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, supervisor.id, title, text, report.project_id, report.task_id, report.id, now());
      const newId = Number(r.lastInsertRowid);
      notify(db, supervisor.id, 'report', `${user.name} حوّل لك ريبورت من ${report.sender_name}`, `#/reports/${newId}`);
      return newId;
    });
    return { report_id: id };
  });
};
