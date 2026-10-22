'use strict';

// Bundles a user's draft requirement items into one request to a manager above them (the direct supervisor by default).

const { HttpError } = require('./http');
const { now } = require('./db');
const { chooseManager, notify, byGender } = require('./access');

async function sendRequirements(db, user, { project, task = null, note = '', recipientId = null }) {
  const supervisor = await chooseManager(db, user, recipientId);
  const draftsSql = task
    ? ['SELECT id FROM requirements WHERE task_id = ? AND requested_by = ? AND request_id IS NULL', task.id, user.id]
    : [`SELECT r.id FROM requirements r JOIN tasks t ON t.id = r.task_id
        WHERE t.project_id = ? AND r.requested_by = ? AND r.request_id IS NULL`, project.id, user.id];

  return db.transaction(async (tx) => {
    const drafts = await tx.all(...draftsSql);
    if (drafts.length === 0) throw new HttpError(400, 'لا توجد متطلبات جديدة لإرسالها');
    const result = await tx.run(`
      INSERT INTO requests (sender_id, recipient_id, scope, project_id, task_id, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, user.id, supervisor.id, task ? 'task' : 'project', project.id, task ? task.id : null, note, now());
    const id = result.lastInsertRowid;
    const ph = drafts.map(() => '?').join(',');
    await tx.run(`UPDATE requirements SET request_id = ? WHERE id IN (${ph})`, id, ...drafts.map((d) => d.id));
    const what = task ? `المهمة «${task.title}»` : `مشروع «${project.name}»`;
    await notify(tx, supervisor.id, 'request', `${byGender(user, 'أرسل', 'أرسلت')} ${user.name} ${drafts.length} من المتطلبات الخاصة بـ${what}`, `#/requests/${id}`);
    return { request_id: id, count: drafts.length };
  });
}

module.exports = { sendRequirements };
