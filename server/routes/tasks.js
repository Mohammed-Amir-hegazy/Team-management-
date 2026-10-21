'use strict';

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const {
  TASK_STATUSES, STATUS_LABELS, PRIORITIES, getUser, subordinateIds, isSelfOrBelow,
  addProjectMember, loadProject, loadTask, canEditTask, canUpdateTaskStatus,
  purgeTasks, notify, personalProject,
} = require('../access');
const { sendRequirements } = require('../requirements');
const { validateImages } = require('../cloudinary');

const TASK_LIST_SQL = `
  SELECT t.*, u.name AS assignee_name, CASE WHEN p.personal_owner_id IS NULL THEN p.name ELSE 'مهمة مستقلة' END AS project_name,
    p.personal_owner_id IS NOT NULL AS standalone
  FROM tasks t
  JOIN users u ON u.id = t.assignee_id
  JOIN projects p ON p.id = t.project_id
`;

function taskWithNames(db, taskId) {
  return db.get(`${TASK_LIST_SQL} WHERE t.id = ?`, taskId);
}

function checkReminder(deadline, reminderAt) {
  if (deadline && reminderAt && reminderAt > deadline) {
    throw new HttpError(400, 'يجب أن يكون موعد التنبيه قبل الموعد النهائي');
  }
}

// Shared by project tasks and standalone tasks (project = null → the assignee's personal container).
async function createTask(db, user, project, body) {
  const title = v.text(body.title, 'عنوان المهمة', { max: 300 });
  const description = v.text(body.description, 'الوصف', { required: false, max: 10000 });
  const assigneeId = v.id(body.assignee_id ?? user.id, 'المسؤول عن المهمة');
  const priority = v.oneOf(body.priority || 'medium', PRIORITIES, 'الأولوية');
  const deadline = v.optionalDate(body.deadline, 'الموعد النهائي');
  const reminderAt = v.optionalDate(body.reminder_at, 'التنبيه');
  checkReminder(deadline, reminderAt);

  if (!(await isSelfOrBelow(db, user, assigneeId))) {
    throw new HttpError(403, 'يمكنك إسناد المهام إلى نفسك أو إلى أعضاء فريقك فقط');
  }
  const assignee = await getUser(db, assigneeId);
  if (!assignee || !assignee.active) throw new HttpError(404, 'المستخدم غير موجود');
  if (project && project.personal_owner_id && project.personal_owner_id !== assigneeId) {
    throw new HttpError(400, 'المهام المستقلة تُسند إلى صاحبها فقط');
  }

  const id = await db.transaction(async (tx) => {
    const target = project || await personalProject(tx, assignee);
    await addProjectMember(tx, target.id, assigneeId);
    const ts = now();
    const r = await tx.run(`
      INSERT INTO tasks (project_id, title, description, assignee_id, created_by, priority,
                         deadline, reminder_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, target.id, title, description, assigneeId, user.id, priority, deadline, reminderAt, ts, ts);
    const taskId = r.lastInsertRowid;
    await tx.run('INSERT INTO task_status_history (task_id, user_id, from_status, to_status, note, created_at) VALUES (?, ?, NULL, ?, ?, ?)',
      taskId, user.id, 'todo', 'تم إنشاء المهمة', ts);
    if (assigneeId !== user.id) {
      await notify(tx, assigneeId, 'task', `أسند إليك ${user.name} مهمة جديدة: «${title}»`, `#/tasks/${taskId}`);
    }
    return taskId;
  });
  return { task: await taskWithNames(db, id) };
}

async function assignableMembers(db, user, projectId) {
  const ids = [user.id, ...(await subordinateIds(db, user.id))];
  const ph = ids.map(() => '?').join(',');
  const rows = await db.all(`
    SELECT u.id, u.name, u.role,
      EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ? AND m.user_id = u.id) AS member
    FROM users u WHERE u.active = 1 AND u.id IN (${ph})
  `, projectId, ...ids);
  return rows.map((u) => ({ ...u, member: !!u.member }));
}

module.exports = function register(router) {
  // scope=mine: assigned to me. scope=team: assigned to anyone below me (optionally one person).
  router.get('/api/tasks', async ({ db, user, query }) => {
    let ids = [user.id];
    if (query.get('scope') === 'team') {
      const team = await subordinateIds(db, user.id);
      const only = v.optionalId(query.get('assignee'), 'الموظف');
      if (only && !team.has(only)) throw new HttpError(403, 'يمكنك متابعة مهام أعضاء فريقك فقط');
      ids = only ? [only] : [...team];
    }
    if (ids.length === 0) return { tasks: [] };
    const params = [...ids];
    let sql = `${TASK_LIST_SQL} WHERE t.assignee_id IN (${ids.map(() => '?').join(',')})`;
    const status = query.get('status');
    if (status === 'overdue') {
      sql += " AND t.status != 'done' AND t.deadline < ?";
      params.push(now());
    } else if (status) {
      sql += ' AND t.status = ?';
      params.push(v.oneOf(status, TASK_STATUSES, 'الحالة'));
    }
    sql += " ORDER BY t.status = 'done', t.deadline IS NULL, t.deadline LIMIT 500";
    return { tasks: await db.all(sql, ...params) };
  });

  router.post('/api/projects/:id/tasks', async ({ db, user, params, body }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    return createTask(db, user, project, body);
  });

  // A standalone task, not under any project (for oneself or for someone in one's team).
  router.post('/api/tasks', async ({ db, user, body }) => createTask(db, user, null, body));

  router.get('/api/tasks/:id', async ({ db, user, params }) => {
    const { task, project } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    const creator = await getUser(db, task.created_by);
    const history = await db.all(`
      SELECT h.*, u.name AS user_name FROM task_status_history h JOIN users u ON u.id = h.user_id
      WHERE h.task_id = ? ORDER BY h.created_at DESC, h.id DESC
    `, task.id);

    // Drafts are private to their author; sent items are visible to the author and anyone above them.
    const subs = await subordinateIds(db, user.id);
    const requirements = (await db.all(`
      SELECT r.*, u.name AS requested_by_name, q.status AS request_status,
             q.response_note AS response_note, q.created_at AS sent_at
      FROM requirements r
      JOIN users u ON u.id = r.requested_by
      LEFT JOIN requests q ON q.id = r.request_id
      WHERE r.task_id = ?
      ORDER BY r.request_id IS NOT NULL, r.created_at DESC
    `, task.id)).filter((r) => r.requested_by === user.id || (r.request_id && subs.has(r.requested_by)));

    const attachments = await db.all(`
      SELECT a.*, u.name AS uploaded_by_name FROM attachments a JOIN users u ON u.id = a.uploaded_by
      WHERE a.task_id = ? ORDER BY a.created_at DESC
    `, task.id);
    const editable = await canEditTask(db, user, task);
    const assignee = await getUser(db, task.assignee_id);
    const canWork = await canUpdateTaskStatus(db, user, task);
    return {
      task: {
        ...(await taskWithNames(db, task.id)),
        creator_name: creator ? creator.name : '',
        assignee_phone: assignee.phone || '',
        assignee_job_title: assignee.job_title || '',
      },
      project: { id: project.id, name: project.name, standalone: !!project.personal_owner_id },
      attachments: attachments.map((a) => ({ ...a, deletable: a.uploaded_by === user.id || editable })),
      history,
      requirements,
      assignable_users: editable ? await assignableMembers(db, user, project.id) : [],
      permissions: {
        edit: editable,
        update_status: canWork,
        upload: canWork,
        remind: task.assignee_id !== user.id && (editable || task.created_by === user.id) && task.status !== 'done',
        set_reminder: editable || task.assignee_id === user.id,
        add_requirements: !!user.supervisor_id,
      },
    };
  });

  router.patch('/api/tasks/:id', async ({ db, user, params, body }) => {
    const { task, project } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    const editable = await canEditTask(db, user, task);
    const isAssignee = task.assignee_id === user.id;
    const onlyReminder = Object.keys(body).every((k) => k === 'reminder_at');
    if (!editable && !(isAssignee && onlyReminder)) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');

    const next = { ...task };
    if (body.title !== undefined) next.title = v.text(body.title, 'عنوان المهمة', { max: 300 });
    if (body.description !== undefined) next.description = v.text(body.description, 'الوصف', { required: false, max: 10000 });
    if (body.priority !== undefined) next.priority = v.oneOf(body.priority, PRIORITIES, 'الأولوية');
    if (body.deadline !== undefined) next.deadline = v.optionalDate(body.deadline, 'الموعد النهائي');
    if (body.reminder_at !== undefined) next.reminder_at = v.optionalDate(body.reminder_at, 'التنبيه');
    if (body.assignee_id !== undefined) {
      next.assignee_id = v.id(body.assignee_id, 'المسؤول عن المهمة');
      if (!(await isSelfOrBelow(db, user, next.assignee_id))) {
        throw new HttpError(403, 'يمكنك إسناد المهام إلى نفسك أو إلى أعضاء فريقك فقط');
      }
      const assignee = await getUser(db, next.assignee_id);
      if (!assignee || !assignee.active) throw new HttpError(404, 'المستخدم غير موجود');
    }
    checkReminder(next.deadline, next.reminder_at);

    // Changing a date re-arms its alarm.
    if (next.deadline !== task.deadline) next.overdue_notified = 0;
    if (next.reminder_at !== task.reminder_at) next.reminder_sent = 0;

    await db.transaction(async (tx) => {
      if (next.assignee_id !== task.assignee_id) {
        // A standalone task follows its new owner into their own standalone tasks.
        if (project.personal_owner_id) next.project_id = (await personalProject(tx, await getUser(tx, next.assignee_id))).id;
        await addProjectMember(tx, next.project_id, next.assignee_id);
        if (next.assignee_id !== user.id) {
          await notify(tx, next.assignee_id, 'task', `أسند إليك ${user.name} المهمة «${next.title}»`, `#/tasks/${task.id}`);
        }
      }
      await tx.run(`
        UPDATE tasks SET title = ?, description = ?, priority = ?, deadline = ?, reminder_at = ?,
          assignee_id = ?, project_id = ?, overdue_notified = ?, reminder_sent = ?, updated_at = ?
        WHERE id = ?
      `, next.title, next.description, next.priority, next.deadline, next.reminder_at,
      next.assignee_id, next.project_id, next.overdue_notified, next.reminder_sent, now(), task.id);
    });
    return { task: await taskWithNames(db, task.id) };
  });

  // Status + reason: so everyone knows where the task stands and why.
  router.post('/api/tasks/:id/status', async ({ db, user, params, body }) => {
    const { task } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    if (!(await canUpdateTaskStatus(db, user, task))) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    const status = v.oneOf(body.status, TASK_STATUSES, 'الحالة');
    const note = v.text(body.note, 'السبب / الملاحظة', { required: status === 'blocked', max: 2000 });
    if (status === task.status && note === task.status_note) return { task: await taskWithNames(db, task.id) };

    const assignee = await getUser(db, task.assignee_id);
    await db.transaction(async (tx) => {
      const ts = now();
      await tx.run('UPDATE tasks SET status = ?, status_note = ?, updated_at = ? WHERE id = ?',
        status, note, ts, task.id);
      await tx.run('INSERT INTO task_status_history (task_id, user_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        task.id, user.id, task.status, status, note, ts);

      const watchers = new Set([task.created_by, task.assignee_id]);
      if (assignee.supervisor_id) watchers.add(assignee.supervisor_id);
      watchers.delete(user.id);
      const reason = note ? `: ${note}` : '';
      for (const uid of watchers) {
        await notify(tx, uid, status === 'blocked' ? 'blocked' : 'status',
          `غيّر ${user.name} حالة المهمة «${task.title}» إلى «${STATUS_LABELS[status]}»${reason}`, `#/tasks/${task.id}`);
      }
    });
    return { task: await taskWithNames(db, task.id) };
  });

  router.delete('/api/tasks/:id', async ({ db, user, params }) => {
    const { task } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    if (!(await canEditTask(db, user, task))) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    await db.transaction((tx) => purgeTasks(tx, 'SELECT ?', task.id));
    return { ok: true };
  });

  // ---- Supporting images ---------------------------------------------------

  // Images already uploaded to Cloudinary by the browser; we record and validate them.
  router.post('/api/tasks/:id/attachments', async ({ db, user, params, body, config }) => {
    const { task } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    if (!(await canUpdateTaskStatus(db, user, task))) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    const images = validateImages(config, body.images);
    const caption = v.text(body.caption, 'الوصف', { required: false, max: 300 });
    const ts = now();
    await db.transaction(async (tx) => {
      for (const img of images) {
        await tx.run(`INSERT INTO attachments (task_id, uploaded_by, url, public_id, width, height, caption, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, task.id, user.id, img.url, img.public_id, img.width, img.height, caption, ts);
      }
      if (task.assignee_id !== user.id) {
        await notify(tx, task.assignee_id, 'task', `أضاف ${user.name} صورًا إلى المهمة «${task.title}»`, `#/tasks/${task.id}`);
      }
    });
    return { ok: true, count: images.length };
  });

  // ---- Reminders -----------------------------------------------------------

  // A supervisor (or the task's creator) nudges the assignee; it rings in the app like an alarm.
  router.post('/api/tasks/:id/remind', async ({ db, user, params, body }) => {
    const { task } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    const allowed = task.assignee_id !== user.id && (task.created_by === user.id || (await canEditTask(db, user, task)));
    if (!allowed) throw new HttpError(403, 'يمكن للمسؤول أو منشئ المهمة فقط تذكير المكلّف بها');
    if (task.status === 'done') throw new HttpError(400, 'المهمة مكتملة بالفعل');
    const message = v.text(body.message, 'نص التذكير', { required: false, max: 1000 });
    const link = `#/tasks/${task.id}`;
    const recent = await db.get(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'nudge' AND link = ? AND created_at > ?`,
      task.assignee_id, link, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if (recent) throw new HttpError(429, 'أُرسل تذكير بهذه المهمة قبل قليل؛ يُرجى الانتظار عشر دقائق');
    await notify(db, task.assignee_id, 'nudge',
      `🔔 يذكّرك ${user.name} بالمهمة «${task.title}»${message ? `: ${message}` : ''}`, link);
    return { ok: true };
  });

  // ---- Requirements -------------------------------------------------------

  router.post('/api/tasks/:id/requirements', async ({ db, user, params, body }) => {
    const { task } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    if (!user.supervisor_id) throw new HttpError(400, 'لا يوجد مسؤول مباشر أعلى منك لطلب المتطلبات منه');
    const description = v.text(body.description, 'وصف المتطلب', { max: 1000 });
    const quantity = v.text(body.quantity, 'الكمية', { required: false, max: 100 });
    const r = await db.run('INSERT INTO requirements (task_id, requested_by, description, quantity, created_at) VALUES (?, ?, ?, ?, ?)',
      task.id, user.id, description, quantity, now());
    return { requirement: await db.get('SELECT * FROM requirements WHERE id = ?', r.lastInsertRowid) };
  });

  router.delete('/api/requirements/:id', async ({ db, user, params }) => {
    const req = await db.get('SELECT * FROM requirements WHERE id = ?', v.id(params.id, 'المتطلب'));
    if (!req || req.requested_by !== user.id) throw new HttpError(404, 'الطلب غير موجود');
    if (req.request_id) throw new HttpError(400, 'لا يمكن حذف متطلب تم إرساله');
    await db.run('DELETE FROM requirements WHERE id = ?', req.id);
    return { ok: true };
  });

  // One click: send every draft requirement this user has on the task.
  router.post('/api/tasks/:id/requirements/send', async ({ db, user, params, body }) => {
    const { task, project } = await loadTask(db, user, v.id(params.id, 'المهمة'));
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 2000 });
    return sendRequirements(db, user, { project, task, note });
  });
};
