'use strict';

// Requests between colleagues: anyone may ask anyone in the company for something; the person asked
// either takes it on as a task of their own (under one of their projects or standalone) or declines it
// with a reason. The person who asked follows the task's progress.

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const { getUser, notify, loadProject } = require('../access');
const { createTask } = require('./tasks');

const PRIORITIES = ['low', 'medium', 'high'];

const SELECT = `
  SELECT w.*, s.name AS sender_name, s.job_title AS sender_job_title, r.name AS recipient_name,
         r.job_title AS recipient_job_title, t.status AS task_status, t.title AS task_title
  FROM work_requests w
  JOIN users s ON s.id = w.sender_id
  JOIN users r ON r.id = w.recipient_id
  LEFT JOIN tasks t ON t.id = w.task_id`;

async function loadRequest(db, user, id) {
  const row = await db.get(`${SELECT} WHERE w.id = ?`, id);
  if (!row || (row.sender_id !== user.id && row.recipient_id !== user.id)) throw new HttpError(404, 'الطلب غير موجود');
  return row;
}

function pendingFor(row, userId, role) {
  if (row.status !== 'pending') throw new HttpError(400, 'تم الرد على هذا الطلب مسبقًا');
  if ((role === 'recipient' ? row.recipient_id : row.sender_id) !== userId) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
}

module.exports = function register(router) {
  // Everyone in the company, to choose whom to ask.
  router.get('/api/colleagues', async ({ db, user }) => {
    const rows = await db.all(`SELECT id, name, job_title, role, photo_version FROM users
      WHERE company_id = ? AND active = 1 AND deleted_at IS NULL AND id != ? ORDER BY name`, user.company_id, user.id);
    return {
      colleagues: rows.map((u) => ({
        id: u.id, name: u.name, job_title: u.job_title, role: u.role,
        photo_url: u.photo_version ? `/api/users/${u.id}/photo?v=${u.photo_version}` : null,
      })),
    };
  });

  router.get('/api/work-requests', async ({ db, user, query }) => {
    const box = v.oneOf(query.get('box') || 'inbox', ['inbox', 'sent'], 'الصندوق');
    const rows = await db.all(`${SELECT} WHERE ${box === 'inbox' ? 'w.recipient_id' : 'w.sender_id'} = ?
      ORDER BY w.status = 'pending' DESC, w.created_at DESC LIMIT 200`, user.id);
    return { requests: rows };
  });

  router.get('/api/work-requests/:id', async ({ db, user, params }) => {
    const request = await loadRequest(db, user, v.id(params.id, 'الطلب'));
    return {
      request,
      permissions: {
        respond: request.status === 'pending' && request.recipient_id === user.id,
        cancel: request.status === 'pending' && request.sender_id === user.id,
      },
    };
  });

  router.post('/api/work-requests', async ({ db, user, body }) => {
    const recipient = await getUser(db, v.id(body.recipient_id, 'الموظف المطلوب'));
    if (!recipient || !recipient.active || recipient.deleted_at || recipient.company_id !== user.company_id) {
      throw new HttpError(400, 'الموظف المطلوب غير موجود');
    }
    if (recipient.id === user.id) throw new HttpError(400, 'لا يمكنك إرسال طلب إلى نفسك؛ يمكنك إضافة مهمة لنفسك مباشرة');
    const title = v.text(body.title, 'عنوان الطلب', { max: 300 });
    const details = v.text(body.details, 'التفاصيل', { required: false, max: 10000 });
    const priority = v.oneOf(body.priority || 'medium', PRIORITIES, 'الأولوية');
    const dueAt = v.optionalDate(body.due_at, 'الموعد المطلوب');
    const id = await db.transaction(async (tx) => {
      const r = await tx.run(`INSERT INTO work_requests (company_id, sender_id, recipient_id, title, details, priority, due_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, user.company_id, user.id, recipient.id, title, details, priority, dueAt, now());
      await notify(tx, recipient.id, 'work_request', `طلب منك ${user.name}: «${title}»`, `#/asks/${r.lastInsertRowid}`);
      return r.lastInsertRowid;
    });
    return { request: await loadRequest(db, user, id) };
  });

  // Taken on as a task of the recipient's own; title, details, deadline and priority can be adjusted.
  router.post('/api/work-requests/:id/accept', async ({ db, user, params, body }) => {
    const row = await loadRequest(db, user, v.id(params.id, 'الطلب'));
    pendingFor(row, user.id, 'recipient');
    const projectId = v.optionalId(body.project_id, 'المشروع');
    const project = projectId ? await loadProject(db, user, projectId) : null;
    if (project && project.personal_owner_id) throw new HttpError(400, 'المشروع المختار غير صالح');
    const { task } = await createTask(db, user, project, {
      title: body.title || row.title,
      description: body.description ?? row.details,
      priority: body.priority || row.priority,
      deadline: body.deadline === undefined ? row.due_at : body.deadline,
      assignee_id: user.id,
    });
    await db.transaction(async (tx) => {
      // Guards against two quick clicks: only a still-pending request is accepted.
      const r = await tx.run(`UPDATE work_requests SET status = 'accepted', task_id = ?, responded_at = ?
        WHERE id = ? AND status = 'pending'`, task.id, now(), row.id);
      if (!r.changes) throw new HttpError(400, 'تم الرد على هذا الطلب مسبقًا');
      await tx.run(`INSERT INTO task_status_history (task_id, user_id, from_status, to_status, note, created_at)
        VALUES (?, ?, 'todo', 'todo', ?, ?)`, task.id, user.id, `بناءً على طلب ${row.sender_name}`, now());
      await notify(tx, row.sender_id, 'work_request', `قبل ${user.name} طلبك «${row.title}» وأضافه إلى مهامه`, `#/tasks/${task.id}`);
    }).catch(async (err) => {
      await db.run('DELETE FROM task_status_history WHERE task_id = ?', task.id);
      await db.run('DELETE FROM tasks WHERE id = ?', task.id);
      throw err;
    });
    return { request: await loadRequest(db, user, row.id), task };
  });

  router.post('/api/work-requests/:id/decline', async ({ db, user, params, body }) => {
    const row = await loadRequest(db, user, v.id(params.id, 'الطلب'));
    pendingFor(row, user.id, 'recipient');
    const note = v.text(body.note, 'سبب الاعتذار', { max: 2000 });
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE work_requests SET status = 'declined', response_note = ?, responded_at = ? WHERE id = ?`, note, now(), row.id);
      await notify(tx, row.sender_id, 'work_request', `اعتذر ${user.name} عن طلبك «${row.title}»: ${note}`, `#/asks/${row.id}`);
    });
    return { request: await loadRequest(db, user, row.id) };
  });

  router.post('/api/work-requests/:id/cancel', async ({ db, user, params }) => {
    const row = await loadRequest(db, user, v.id(params.id, 'الطلب'));
    pendingFor(row, user.id, 'sender');
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE work_requests SET status = 'cancelled', responded_at = ? WHERE id = ?`, now(), row.id);
      await notify(tx, row.recipient_id, 'work_request', `ألغى ${user.name} طلبه «${row.title}»`, `#/asks/${row.id}`);
    });
    return { request: await loadRequest(db, user, row.id) };
  });
};
