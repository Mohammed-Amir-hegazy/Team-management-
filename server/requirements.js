'use strict';

// Bundles a user's draft requirement items into one request to their direct supervisor.

const { HttpError } = require('./http');
const { now, transaction } = require('./db');
const { requireSupervisor, notify } = require('./access');

function sendRequirements(db, user, { project, task = null, note = '' }) {
  const supervisor = requireSupervisor(db, user);
  const drafts = task
    ? db.prepare('SELECT id FROM requirements WHERE task_id = ? AND requested_by = ? AND request_id IS NULL')
      .all(task.id, user.id)
    : db.prepare(`
        SELECT r.id FROM requirements r JOIN tasks t ON t.id = r.task_id
        WHERE t.project_id = ? AND r.requested_by = ? AND r.request_id IS NULL
      `).all(project.id, user.id);
  if (drafts.length === 0) throw new HttpError(400, 'لا توجد طلبات جديدة لإرسالها');

  const requestId = transaction(db, () => {
    const result = db.prepare(`
      INSERT INTO requests (sender_id, recipient_id, scope, project_id, task_id, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, supervisor.id, task ? 'task' : 'project', project.id, task ? task.id : null, note, now());
    const id = Number(result.lastInsertRowid);
    const link = db.prepare('UPDATE requirements SET request_id = ? WHERE id = ?');
    for (const d of drafts) link.run(id, d.id);
    const what = task ? `التاسك "${task.title}"` : `مشروع "${project.name}"`;
    notify(db, supervisor.id, 'request', `${user.name} أرسل ${drafts.length} طلب/طلبات لـ ${what}`, `#/requests/${id}`);
    return id;
  });
  return { request_id: requestId, count: drafts.length };
}

// Forwarded requests point back to the original; the items stay attached to the original.
function rootRequestId(db, requestId) {
  let current = db.prepare('SELECT id, forwarded_from_id FROM requests WHERE id = ?').get(requestId);
  while (current && current.forwarded_from_id) {
    current = db.prepare('SELECT id, forwarded_from_id FROM requests WHERE id = ?').get(current.forwarded_from_id);
  }
  return current ? current.id : requestId;
}

module.exports = { sendRequirements, rootRequestId };
