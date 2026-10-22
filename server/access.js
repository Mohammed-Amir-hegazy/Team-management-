'use strict';

// Role hierarchy and every permission rule lives here so the routes stay declarative.

const { HttpError } = require('./http');
const { queuePush } = require('./push');
const { now } = require('./db');

// Organisational levels, highest first. A user's `role` column holds their highest level;
// `roles` holds every role they carry, including the non-hierarchical system admin.
const ORG_ROLES = ['owner', 'manager', 'team_leader', 'employee'];
const ROLES = [...ORG_ROLES, 'admin'];
const ROLE_LABELS = {
  owner: 'صاحب الشركة',
  admin: 'مسؤول النظام',
  manager: 'مدير',
  team_leader: 'قائد فريق',
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
  return ORG_ROLES.indexOf(role);
}

function userRoles(user) {
  return String(user.roles || user.role).split(',').filter((r) => ROLES.includes(r));
}

// The owner and system admins manage accounts (create, edit roles, suspend).
function isAdmin(user) {
  const roles = userRoles(user);
  return roles.includes('owner') || roles.includes('admin');
}

function primaryRole(roles) {
  return ORG_ROLES.find((r) => roles.includes(r)) || null;
}

function getUser(db, userId) {
  return db.get('SELECT * FROM users WHERE id = ?', userId);
}

// Everyone below userId in the reporting tree (not including userId).
async function subordinateIds(db, userId) {
  const rows = await db.all(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM users WHERE supervisor_id = ?
      UNION ALL
      SELECT u.id FROM users u JOIN sub ON u.supervisor_id = sub.id
    )
    SELECT id FROM sub
  `, userId);
  return new Set(rows.map((r) => r.id));
}

// Supervisor chain of userId, nearest first (not including userId).
async function ancestorIds(db, userId) {
  const rows = await db.all(`
    WITH RECURSIVE up(id, supervisor_id, depth) AS (
      SELECT id, supervisor_id, 0 FROM users WHERE id = ?
      UNION ALL
      SELECT u.id, u.supervisor_id, up.depth + 1 FROM users u JOIN up ON u.id = up.supervisor_id
    )
    SELECT id FROM up WHERE depth > 0 ORDER BY depth
  `, userId);
  return rows.map((r) => r.id);
}

async function isAbove(db, upperId, lowerId) {
  return (await ancestorIds(db, lowerId)).includes(upperId);
}

// Self or anyone below: the people a user may assign work to.
async function isSelfOrBelow(db, user, otherId) {
  return user.id === otherId || isAbove(db, user.id, otherId);
}

// Reports and requests go to any manager above in the person's own chain; the direct supervisor
// when none is chosen.
async function chooseManager(db, user, recipientId) {
  if (recipientId === undefined || recipientId === null || recipientId === '') return requireSupervisor(db, user);
  const id = Number(recipientId);
  if (!(await ancestorIds(db, user.id)).includes(id)) {
    throw new HttpError(403, 'يمكنك الإرسال إلى أحد مسؤوليك في التسلسل الإداري فقط');
  }
  const manager = await getUser(db, id);
  if (!manager || !manager.active) throw new HttpError(400, 'المسؤول المختار غير متاح حاليًا');
  return manager;
}

// Wording that follows a person's gender (the masculine form when it is not set).
function byGender(user, male, female) {
  return user && user.gender === 'female' ? female : male;
}

// "الزميل كريم" / "الزميلة سارة"; just the name when the gender is not set.
function colleagueName(user) {
  if (user.gender === 'female') return `الزميلة ${user.name}`;
  if (user.gender === 'male') return `الزميل ${user.name}`;
  return user.name;
}

async function requireSupervisor(db, user) {
  if (!user.supervisor_id) {
    throw new HttpError(400, 'لا يوجد مسؤول مباشر أعلى منك لإرسال هذا إليه');
  }
  const supervisor = await getUser(db, user.supervisor_id);
  if (!supervisor || !supervisor.active) {
    throw new HttpError(400, 'المسؤول المباشر عنك غير متاح حاليًا');
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
    return db.all('SELECT * FROM projects WHERE company_id = ? ORDER BY created_at DESC', user.company_id);
  }
  return db.all(`${VISIBLE_PROJECTS_SQL} ORDER BY p.created_at DESC`, user.id, user.id);
}

// Projects never cross company boundaries; within a company the owner sees everything.
async function canSeeProject(db, user, project) {
  if (!project || project.company_id !== user.company_id) return false;
  if (user.role === 'owner') return true;
  return !!(await db.get(`${VISIBLE_PROJECTS_SQL} AND p.id = ?`, user.id, user.id, project.id));
}

// A person's standalone-tasks container is never edited, renamed or deleted directly.
function canManageProject(user, project) {
  if (project.personal_owner_id) return false;
  return user.role === 'owner' || project.created_by === user.id;
}

// The hidden project that holds a person's standalone tasks, created on first use.
async function personalProject(db, owner) {
  const existing = await db.get('SELECT * FROM projects WHERE personal_owner_id = ?', owner.id);
  if (existing) return existing;
  await db.run(`
    INSERT OR IGNORE INTO projects (name, description, created_by, personal_owner_id, company_id, created_at)
    VALUES (?, '', ?, ?, ?, ?)
  `, `مهام مستقلة — ${owner.name}`, owner.id, owner.id, owner.company_id, now());
  const project = await db.get('SELECT * FROM projects WHERE personal_owner_id = ?', owner.id);
  await addProjectMember(db, project.id, owner.id);
  return project;
}

async function isProjectMember(db, projectId, userId) {
  return !!(await db.get('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId));
}

function addProjectMember(db, projectId, userId) {
  return db.run('INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)',
    projectId, userId, now());
}

async function loadProject(db, user, projectId) {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project || !(await canSeeProject(db, user, project))) throw new HttpError(404, 'المشروع غير موجود');
  return project;
}

// ---- Tasks ----------------------------------------------------------------

async function loadTask(db, user, taskId) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) throw new HttpError(404, 'المهمة غير موجودة');
  const project = await db.get('SELECT * FROM projects WHERE id = ?', task.project_id);
  // Whoever asked for the task (a colleague's request) follows it too.
  if (!(await canSeeProject(db, user, project))
    && !(await db.get('SELECT 1 FROM work_requests WHERE task_id = ? AND sender_id = ?', task.id, user.id))) {
    throw new HttpError(404, 'المهمة غير موجودة');
  }
  return { task, project };
}

// Edit details, reassign, delete: the creator, the owner, or anyone above the assignee.
async function canEditTask(db, user, task) {
  return user.role === 'owner' || task.created_by === user.id || isAbove(db, user.id, task.assignee_id);
}

async function canUpdateTaskStatus(db, user, task) {
  return task.assignee_id === user.id || canEditTask(db, user, task);
}

// Removes tasks and everything hanging off them. Done explicitly rather than relying on
// ON DELETE CASCADE so it behaves the same whether or not foreign keys are enforced.
// taskIdsSql is a SELECT returning the ids of the tasks to remove.
async function purgeTasks(db, taskIdsSql, ...args) {
  const inTasks = `IN (${taskIdsSql})`;
  await db.run(`UPDATE reports SET task_id = NULL WHERE task_id ${inTasks}`, ...args);
  await db.run(`UPDATE work_requests SET task_id = NULL WHERE task_id ${inTasks}`, ...args);
  await db.run(`DELETE FROM attachments WHERE task_id ${inTasks}`, ...args);
  await db.run(`DELETE FROM requirements WHERE task_id ${inTasks}`, ...args);
  await db.run(`DELETE FROM task_status_history WHERE task_id ${inTasks}`, ...args);
  await purgeRequests(db, `SELECT id FROM requests WHERE task_id ${inTasks}`, ...args);
  await db.run(`DELETE FROM tasks WHERE id ${inTasks}`, ...args);
}

async function purgeRequests(db, requestIdsSql, ...args) {
  const ids = (await db.all(requestIdsSql, ...args)).map((r) => r.id);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  await db.run(`UPDATE requirements SET request_id = NULL WHERE request_id IN (${ph})`, ...ids);
  await db.run(`UPDATE requests SET forwarded_from_id = NULL, root_id = NULL WHERE id IN (${ph})`, ...ids);
  await db.run(`DELETE FROM requests WHERE id IN (${ph})`, ...ids);
}

async function deleteProject(db, projectId) {
  await purgeTasks(db, 'SELECT id FROM tasks WHERE project_id = ?', projectId);
  await purgeRequests(db, 'SELECT id FROM requests WHERE project_id = ?', projectId);
  await db.run('UPDATE reports SET project_id = NULL WHERE project_id = ?', projectId);
  await db.run('DELETE FROM project_members WHERE project_id = ?', projectId);
  await db.run('DELETE FROM projects WHERE id = ?', projectId);
}

// ---- Notifications --------------------------------------------------------

// An in-app notification, also pushed to the person's phones and browsers.
async function notify(db, userId, type, message, link = '') {
  const result = await db.run('INSERT INTO notifications (user_id, type, message, link, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, type, message, link, now());
  queuePush(userId, message, link);
  return result;
}

function publicUser(user) {
  if (!user) return null;
  const roles = userRoles(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    job_title: user.job_title || '',
    phone: user.phone || '',
    gender: user.gender || '',
    role: user.role,
    role_label: ROLE_LABELS[user.role],
    roles,
    role_labels: roles.map((r) => ROLE_LABELS[r]),
    is_admin: isAdmin(user),
    is_platform: !!user.is_platform,
    company_id: user.company_id,
    supervisor_id: user.supervisor_id,
    // Versioned so a changed photo is fetched again while an unchanged one stays cached.
    photo_url: user.photo_version ? `/api/users/${user.id}/photo?v=${user.photo_version}` : null,
    active: !!user.active,
    created_at: user.created_at,
  };
}

module.exports = {
  chooseManager,
  byGender,
  colleagueName,
  ORG_ROLES,
  ROLES,
  ROLE_LABELS,
  TASK_STATUSES,
  STATUS_LABELS,
  PROJECT_STATUSES,
  PRIORITIES,
  roleRank,
  userRoles,
  isAdmin,
  primaryRole,
  getUser,
  subordinateIds,
  ancestorIds,
  isAbove,
  isSelfOrBelow,
  requireSupervisor,
  visibleProjects,
  canSeeProject,
  canManageProject,
  personalProject,
  isProjectMember,
  addProjectMember,
  loadProject,
  loadTask,
  canEditTask,
  canUpdateTaskStatus,
  purgeTasks,
  deleteProject,
  notify,
  publicUser,
};
