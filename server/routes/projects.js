'use strict';

const { HttpError } = require('../http');
const { now, transaction } = require('../db');
const v = require('../validate');
const {
  PROJECT_STATUSES, getUser, subordinateIds, isSelfOrBelow, visibleProjects, canManageProject,
  isProjectMember, addProjectMember, loadProject, publicUser, notify,
} = require('../access');
const { sendRequirements } = require('../requirements');

function projectSummary(db, user, project) {
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(status = 'done') AS done,
           SUM(status = 'blocked') AS blocked,
           SUM(assignee_id = ? AND status != 'done') AS mine_open,
           SUM(deadline IS NOT NULL AND deadline < ? AND status != 'done') AS overdue
    FROM tasks WHERE project_id = ?
  `).get(user.id, now(), project.id);
  const members = db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').get(project.id).n;
  const creator = getUser(db, project.created_by);
  return {
    ...project,
    creator_name: creator ? creator.name : '',
    members_count: members,
    tasks_total: counts.total,
    tasks_done: counts.done || 0,
    tasks_blocked: counts.blocked || 0,
    my_open_tasks: counts.mine_open || 0,
    tasks_overdue: counts.overdue || 0,
  };
}

module.exports = function register(router) {
  router.get('/api/projects', ({ db, user }) => ({
    projects: visibleProjects(db, user).map((p) => projectSummary(db, user, p)),
  }));

  router.post('/api/projects', ({ db, user, body }) => {
    if (user.role === 'employee') throw new HttpError(403, 'الموظف لا يمكنه إنشاء مشروع');
    const name = v.text(body.name, 'اسم المشروع', { max: 200 });
    const description = v.text(body.description, 'الوصف', { required: false, max: 5000 });
    const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map((x) => v.id(x, 'العضو')) : [];
    const subs = subordinateIds(db, user.id);
    for (const mid of memberIds) {
      if (mid !== user.id && !subs.has(mid)) throw new HttpError(403, 'تقدر تضيف بس الناس اللي تحتك');
    }
    const project = transaction(db, () => {
      const r = db.prepare('INSERT INTO projects (name, description, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(name, description, user.id, now());
      const id = Number(r.lastInsertRowid);
      addProjectMember(db, id, user.id);
      for (const mid of memberIds) {
        addProjectMember(db, id, mid);
        if (mid !== user.id) notify(db, mid, 'project', `تمت إضافتك لمشروع "${name}"`, `#/projects/${id}`);
      }
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    });
    return { project: projectSummary(db, user, project) };
  });

  router.get('/api/projects/:id', ({ db, user, params }) => {
    const project = loadProject(db, user, v.id(params.id, 'المشروع'));
    const subs = subordinateIds(db, user.id);
    const members = db.prepare(`
      SELECT u.* FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? ORDER BY u.name
    `).all(project.id).map((u) => ({
      ...publicUser(u),
      assignable: u.id === user.id || subs.has(u.id),
      removable: canManageProject(user, project) || subs.has(u.id),
    }));
    const memberSet = new Set(members.map((m) => m.id));
    const addable = [...subs]
      .map((id) => getUser(db, id))
      .filter((u) => u.active && !memberSet.has(u.id))
      .map(publicUser);
    const tasks = db.prepare(`
      SELECT t.*, u.name AS assignee_name,
        (SELECT COUNT(*) FROM requirements r WHERE r.task_id = t.id) AS requirements_count
      FROM tasks t JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = ?
      ORDER BY t.status = 'done', t.deadline IS NULL, t.deadline
    `).all(project.id);
    const myDrafts = db.prepare(`
      SELECT COUNT(*) AS n FROM requirements r JOIN tasks t ON t.id = r.task_id
      WHERE t.project_id = ? AND r.requested_by = ? AND r.request_id IS NULL
    `).get(project.id, user.id).n;
    const isMember = memberSet.has(user.id);
    return {
      project: projectSummary(db, user, project),
      members,
      addable_users: addable,
      tasks,
      my_draft_requirements: myDrafts,
      permissions: {
        manage: canManageProject(user, project),
        add_members: canManageProject(user, project) || (isMember && user.role !== 'employee'),
        create_tasks: true,
        send_requests: !!user.supervisor_id,
      },
    };
  });

  router.patch('/api/projects/:id', ({ db, user, params, body }) => {
    const project = loadProject(db, user, v.id(params.id, 'المشروع'));
    if (!canManageProject(user, project)) throw new HttpError(403, 'غير مسموح');
    const name = body.name !== undefined ? v.text(body.name, 'اسم المشروع', { max: 200 }) : project.name;
    const description = body.description !== undefined
      ? v.text(body.description, 'الوصف', { required: false, max: 5000 }) : project.description;
    const status = body.status !== undefined ? v.oneOf(body.status, PROJECT_STATUSES, 'الحالة') : project.status;
    db.prepare('UPDATE projects SET name = ?, description = ?, status = ? WHERE id = ?')
      .run(name, description, status, project.id);
    return { project: projectSummary(db, user, db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id)) };
  });

  router.delete('/api/projects/:id', ({ db, user, params }) => {
    const project = loadProject(db, user, v.id(params.id, 'المشروع'));
    if (!canManageProject(user, project)) throw new HttpError(403, 'غير مسموح');
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    return { ok: true };
  });

  router.post('/api/projects/:id/members', ({ db, user, params, body }) => {
    const project = loadProject(db, user, v.id(params.id, 'المشروع'));
    const memberId = v.id(body.user_id, 'العضو');
    const allowed = canManageProject(user, project)
      || (isProjectMember(db, project.id, user.id) && user.role !== 'employee');
    if (!allowed) throw new HttpError(403, 'غير مسموح');
    if (!isSelfOrBelow(db, user, memberId)) throw new HttpError(403, 'تقدر تضيف بس الناس اللي تحتك');
    const member = getUser(db, memberId);
    if (!member || !member.active) throw new HttpError(404, 'المستخدم غير موجود');
    addProjectMember(db, project.id, memberId);
    if (memberId !== user.id) {
      notify(db, memberId, 'project', `تمت إضافتك لمشروع "${project.name}"`, `#/projects/${project.id}`);
    }
    return { ok: true };
  });

  router.delete('/api/projects/:id/members/:userId', ({ db, user, params }) => {
    const project = loadProject(db, user, v.id(params.id, 'المشروع'));
    const memberId = v.id(params.userId, 'العضو');
    if (!canManageProject(user, project) && !subordinateIds(db, user.id).has(memberId)) {
      throw new HttpError(403, 'غير مسموح');
    }
    if (memberId === project.created_by) throw new HttpError(400, 'لا يمكن إزالة منشئ المشروع');
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND assignee_id = ? AND status != 'done'")
      .get(project.id, memberId);
    if (n > 0) throw new HttpError(400, 'العضو عليه تاسكات مفتوحة في المشروع، انقلها لحد تاني الأول');
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(project.id, memberId);
    return { ok: true };
  });

  // One click: send every draft requirement this user has in the project.
  router.post('/api/projects/:id/requirements/send', ({ db, user, params, body }) => {
    const project = loadProject(db, user, v.id(params.id, 'المشروع'));
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 2000 });
    return sendRequirements(db, user, { project, note });
  });
};
