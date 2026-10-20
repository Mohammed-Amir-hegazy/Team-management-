'use strict';

// Role hierarchy and every permission rule lives here so the routes stay declarative.

const { HttpError } = require('./http');
const { now } = require('./db');

const ROLES = ['owner', 'manager', 'team_leader', 'employee'];
const ROLE_LABELS = {
  owner: 'صاحب الشركة',
  manager: 'مدير',
  team_leader: 'تيم ليدر',
  employee: 'موظف',
};
const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done'];
const STATUS_LABELS = {
  todo: 'لم تبدأ',
  in_progress: 'قيد التنفيذ',
  blocked: 'متوقفة',
  review: 'قيد المراجعة',
  done: 'مكتملة',
};
const PROJECT_STATUSES = ['active', 'on_hold', 'completed'];
const PRIORITIES = ['low', 'medium', 'high'];

function roleRank(role) {
  return ROLES.indexOf(role);
}

function getUser(db, userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

// Everyone below userId in the reporting tree (not including userId).
function subordinateIds(db, userId) {
  const rows = db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM users WHERE supervisor_id = ?
      UNION ALL
      SELECT u.id FROM users u JOIN sub ON u.supervisor_id = sub.id
    )
    SELECT id FROM sub
  `).all(userId);
  return new Set(rows.map((r) => r.id));
}

// Supervisor chain of userId, nearest first (not including userId).
function ancestorIds(db, userId) {
  const rows = db.prepare(`
    WITH RECURSIVE up(id, supervisor_id, depth) AS (
      SELECT id, supervisor_id, 0 FROM users WHERE id = ?
      UNION ALL
      SELECT u.id, u.supervisor_id, up.depth + 1 FROM users u JOIN up ON u.id = up.supervisor_id
    )
    SELECT id FROM up WHERE depth > 0 ORDER BY depth
  `).all(userId);
  return rows.map((r) => r.id);
}

function isAbove(db, upperId, lowerId) {
  return ancestorIds(db, lowerId).includes(upperId);
}

// Self or anyone below: the people a user may assign work to.
function isSelfOrBelow(db, user, otherId) {
  return user.id === otherId || isAbove(db, user.id, otherId);
}

function requireSupervisor(db, user) {
  if (!user.supervisor_id) {
    throw new HttpError(400, 'لا يوجد مسؤول أعلى منك لإرسال هذا إليه');
  }
  const supervisor = getUser(db, user.supervisor_id);
  if (!supervisor || !supervisor.active) {
    throw new HttpError(400, 'المسؤول المباشر عنك غير متاح حالياً');
  }
  return supervisor;
}

// ---- Projects -------------------------------------------------------------

const VISIBLE_PROJECTS_SQL = `
  WITH RECURSIVE team(id) AS (
    SELECT ?
    UNION ALL
    SELECT u.id FROM users u JOIN team ON u.supervisor_id = team.id
  )
  SELECT p.* FROM projects p
  WHERE p.created_by = ?
     OR EXISTS (SELECT 1 FROM project_members m
                WHERE m.project_id = p.id AND m.user_id IN (SELECT id FROM team))
`;

function visibleProjects(db, user) {
  if (user.role === 'owner') {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  }
  return db.prepare(`${VISIBLE_PROJECTS_SQL} ORDER BY p.created_at DESC`).all(user.id, user.id);
}

function canSeeProject(db, user, project) {
  if (user.role === 'owner') return true;
  return !!db.prepare(`${VISIBLE_PROJECTS_SQL} AND p.id = ?`).get(user.id, user.id, project.id);
}

function canManageProject(user, project) {
  return user.role === 'owner' || project.created_by === user.id;
}

function isProjectMember(db, projectId, userId) {
  return !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
}

function addProjectMember(db, projectId, userId) {
  db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)')
    .run(projectId, userId, now());
}

function loadProject(db, user, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project || !canSeeProject(db, user, project)) throw new HttpError(404, 'المشروع غير موجود');
  return project;
}

// ---- Tasks ----------------------------------------------------------------

function loadTask(db, user, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new HttpError(404, 'التاسك غير موجودة');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id);
  if (!canSeeProject(db, user, project)) throw new HttpError(404, 'التاسك غير موجودة');
  return { task, project };
}

// Edit details, reassign, delete: the creator, the owner, or anyone above the assignee.
function canEditTask(db, user, task) {
  return user.role === 'owner' || task.created_by === user.id || isAbove(db, user.id, task.assignee_id);
}

function canUpdateTaskStatus(db, user, task) {
  return task.assignee_id === user.id || canEditTask(db, user, task);
}

// ---- Notifications --------------------------------------------------------

function notify(db, userId, type, message, link = '') {
  db.prepare('INSERT INTO notifications (user_id, type, message, link, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, type, message, link, now());
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    role_label: ROLE_LABELS[user.role],
    supervisor_id: user.supervisor_id,
    active: !!user.active,
    created_at: user.created_at,
  };
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  TASK_STATUSES,
  STATUS_LABELS,
  PROJECT_STATUSES,
  PRIORITIES,
  roleRank,
  getUser,
  subordinateIds,
  ancestorIds,
  isAbove,
  isSelfOrBelow,
  requireSupervisor,
  visibleProjects,
  canSeeProject,
  canManageProject,
  isProjectMember,
  addProjectMember,
  loadProject,
  loadTask,
  canEditTask,
  canUpdateTaskStatus,
  notify,
  publicUser,
};
