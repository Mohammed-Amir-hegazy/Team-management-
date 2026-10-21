'use strict';

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const {
  PROJECT_STATUSES, getUser, subordinateIds, isSelfOrBelow, visibleProjects, canManageProject,
  isProjectMember, addProjectMember, loadProject, deleteProject, publicUser, notify,
} = require('../access');
const { sendRequirements } = require('../requirements');

// Projects with their counters, in one query (each query is a network round trip on Turso).
async function projectSummaries(db, user, projectIds) {
  if (!projectIds.length) return [];
  const ph = projectIds.map(() => '?').join(',');
  return db.all(`
    SELECT p.*, c.name AS creator_name,
      (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS members_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS tasks_total,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS tasks_done,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'blocked') AS tasks_blocked,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.assignee_id = ? AND t.status != 'done') AS my_open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deadline < ? AND t.status != 'done') AS tasks_overdue
    FROM projects p JOIN users c ON c.id = p.created_by
    WHERE p.id IN (${ph})
    ORDER BY p.created_at DESC
  `, user.id, now(), ...projectIds);
}

async function projectSummary(db, user, projectId) {
  return (await projectSummaries(db, user, [projectId]))[0];
}

module.exports = function register(router) {
  router.get('/api/projects', async ({ db, user }) => {
    const ids = (await visibleProjects(db, user)).filter((p) => !p.personal_owner_id).map((p) => p.id);
    return { projects: await projectSummaries(db, user, ids) };
  });

  router.post('/api/projects', async ({ db, user, body }) => {
    if (user.role === 'employee') throw new HttpError(403, 'إنشاء المشاريع متاح للمديرين وقادة الفرق وصاحب الشركة فقط');
    const name = v.text(body.name, 'اسم المشروع', { max: 200 });
    const description = v.text(body.description, 'الوصف', { required: false, max: 5000 });
    const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map((x) => v.id(x, 'العضو')) : [];
    const subs = await subordinateIds(db, user.id);
    for (const mid of memberIds) {
      if (mid !== user.id && !subs.has(mid)) throw new HttpError(403, 'يمكنك إضافة أعضاء فريقك فقط');
    }
    const id = await db.transaction(async (tx) => {
      const r = await tx.run('INSERT INTO projects (name, description, created_by, created_at) VALUES (?, ?, ?, ?)',
        name, description, user.id, now());
      const projectId = r.lastInsertRowid;
      await addProjectMember(tx, projectId, user.id);
      for (const mid of memberIds) {
        await addProjectMember(tx, projectId, mid);
        if (mid !== user.id) await notify(tx, mid, 'project', `تمت إضافتك إلى مشروع «${name}»`, `#/projects/${projectId}`);
      }
      return projectId;
    });
    return { project: await projectSummary(db, user, id) };
  });

  router.get('/api/projects/:id', async ({ db, user, params }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    const subs = await subordinateIds(db, user.id);
    const manage = canManageProject(user, project);
    const members = (await db.all(`
      SELECT u.* FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? ORDER BY u.name
    `, project.id)).map((u) => ({
      ...publicUser(u),
      assignable: u.id === user.id || subs.has(u.id),
      removable: manage || subs.has(u.id),
    }));
    const memberSet = new Set(members.map((m) => m.id));
    let addable = [];
    if (subs.size) {
      const ph = [...subs].map(() => '?').join(',');
      addable = (await db.all(`SELECT * FROM users WHERE active = 1 AND id IN (${ph})`, ...subs))
        .filter((u) => !memberSet.has(u.id))
        .map(publicUser);
    }
    const tasks = await db.all(`
      SELECT t.*, u.name AS assignee_name,
        (SELECT COUNT(*) FROM requirements r WHERE r.task_id = t.id) AS requirements_count
      FROM tasks t JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = ?
      ORDER BY t.status = 'done', t.deadline IS NULL, t.deadline
    `, project.id);
    const { n: myDrafts } = await db.get(`
      SELECT COUNT(*) AS n FROM requirements r JOIN tasks t ON t.id = r.task_id
      WHERE t.project_id = ? AND r.requested_by = ? AND r.request_id IS NULL
    `, project.id, user.id);
    const isMember = memberSet.has(user.id);
    return {
      project: await projectSummary(db, user, project.id),
      members,
      addable_users: addable,
      tasks,
      my_draft_requirements: myDrafts,
      permissions: {
        manage,
        add_members: !project.personal_owner_id && (manage || (isMember && user.role !== 'employee')),
        create_tasks: true,
        send_requests: !!user.supervisor_id,
      },
    };
  });

  router.patch('/api/projects/:id', async ({ db, user, params, body }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    if (!canManageProject(user, project)) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    const name = body.name !== undefined ? v.text(body.name, 'اسم المشروع', { max: 200 }) : project.name;
    const description = body.description !== undefined
      ? v.text(body.description, 'الوصف', { required: false, max: 5000 }) : project.description;
    const status = body.status !== undefined ? v.oneOf(body.status, PROJECT_STATUSES, 'الحالة') : project.status;
    await db.run('UPDATE projects SET name = ?, description = ?, status = ? WHERE id = ?',
      name, description, status, project.id);
    return { project: await projectSummary(db, user, project.id) };
  });

  router.delete('/api/projects/:id', async ({ db, user, params }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    if (!canManageProject(user, project)) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    await db.transaction((tx) => deleteProject(tx, project.id));
    return { ok: true };
  });

  router.post('/api/projects/:id/members', async ({ db, user, params, body }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    const memberId = v.id(body.user_id, 'العضو');
    if (project.personal_owner_id) throw new HttpError(400, 'لا يمكن إضافة أعضاء إلى المهام المستقلة');
    const allowed = canManageProject(user, project)
      || ((await isProjectMember(db, project.id, user.id)) && user.role !== 'employee');
    if (!allowed) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    if (!(await isSelfOrBelow(db, user, memberId))) throw new HttpError(403, 'يمكنك إضافة أعضاء فريقك فقط');
    const member = await getUser(db, memberId);
    if (!member || !member.active) throw new HttpError(404, 'المستخدم غير موجود');
    await addProjectMember(db, project.id, memberId);
    if (memberId !== user.id) {
      await notify(db, memberId, 'project', `تمت إضافتك إلى مشروع «${project.name}»`, `#/projects/${project.id}`);
    }
    return { ok: true };
  });

  router.delete('/api/projects/:id/members/:userId', async ({ db, user, params }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    const memberId = v.id(params.userId, 'العضو');
    if (!canManageProject(user, project) && !(await subordinateIds(db, user.id)).has(memberId)) {
      throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    }
    if (memberId === project.created_by) throw new HttpError(400, 'لا يمكن إزالة منشئ المشروع');
    const { n } = await db.get("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND assignee_id = ? AND status != 'done'",
      project.id, memberId);
    if (n > 0) throw new HttpError(400, 'لدى هذا العضو مهام مفتوحة في المشروع؛ يُرجى إسنادها إلى عضو آخر أولًا');
    await db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', project.id, memberId);
    return { ok: true };
  });

  // One click: send every draft requirement this user has in the project.
  router.post('/api/projects/:id/requirements/send', async ({ db, user, params, body }) => {
    const project = await loadProject(db, user, v.id(params.id, 'المشروع'));
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 2000 });
    return sendRequirements(db, user, { project, note });
  });
};
