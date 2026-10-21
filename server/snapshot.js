'use strict';

// Work-status figures shared by report snapshots and the team report.

const { now } = require('./db');
const { subordinateIds } = require('./access');

const TASK_FIELDS = `
  t.id, t.title, t.status, t.status_note, t.priority, t.deadline, t.updated_at, t.assignee_id,
  p.name AS project_name, u.name AS assignee_name
`;
const TASK_FROM = 'FROM tasks t JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = t.assignee_id';

function placeholders(list) {
  return list.map(() => '?').join(',');
}

function markOverdue(tasks, ts) {
  return tasks.map((t) => ({ ...t, overdue: t.status !== 'done' && !!t.deadline && t.deadline < ts }));
}

function summarize(tasks) {
  const out = { total: tasks.length, todo: 0, in_progress: 0, blocked: 0, review: 0, done: 0, overdue: 0 };
  for (const t of tasks) {
    out[t.status]++;
    if (t.overdue) out.overdue++;
  }
  return out;
}

// Per-person task counters; `since` adds how many tasks each person completed from that date on.
async function memberStats(db, userIds, { projectId = null, since = null } = {}) {
  if (!userIds.length) return new Map();
  const ts = now();
  const rows = await db.all(`
    SELECT assignee_id,
      COUNT(*) AS total,
      SUM(status = 'todo') AS todo,
      SUM(status = 'in_progress') AS in_progress,
      SUM(status = 'blocked') AS blocked,
      SUM(status = 'review') AS review,
      SUM(status = 'done') AS done,
      SUM(status != 'done' AND deadline IS NOT NULL AND deadline < ?) AS overdue,
      SUM(status = 'done' AND EXISTS (
        SELECT 1 FROM task_status_history h
        WHERE h.task_id = tasks.id AND h.to_status = 'done' AND h.created_at >= ?)) AS done_in_period
    FROM tasks
    WHERE assignee_id IN (${placeholders(userIds)}) ${projectId ? 'AND project_id = ?' : ''}
    GROUP BY assignee_id
  `, ts, since || '9999', ...userIds, ...(projectId ? [projectId] : []));
  return new Map(rows.map((r) => [r.assignee_id, r]));
}

const EMPTY_STATS = { total: 0, todo: 0, in_progress: 0, blocked: 0, review: 0, done: 0, overdue: 0, done_in_period: 0 };

// What a report carries: the sender's tasks in scope and, for leaders, their team's counters.
async function workSnapshot(db, user, { projectId = null, taskId = null } = {}) {
  const ts = now();
  const recent = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  let tasks;
  if (taskId) {
    tasks = await db.all(`SELECT ${TASK_FIELDS} ${TASK_FROM} WHERE t.id = ?`, taskId);
  } else {
    tasks = await db.all(`
      SELECT ${TASK_FIELDS} ${TASK_FROM}
      WHERE t.assignee_id = ? ${projectId ? 'AND t.project_id = ?' : ''}
        AND (t.status != 'done' OR t.updated_at >= ?)
      ORDER BY t.status = 'done', t.deadline IS NULL, t.deadline
      LIMIT 300
    `, user.id, ...(projectId ? [projectId] : []), recent);
  }
  tasks = markOverdue(tasks, ts);

  let team = [];
  if (!taskId) {
    const ids = [...(await subordinateIds(db, user.id))];
    if (ids.length) {
      const stats = await memberStats(db, ids, { projectId });
      const people = await db.all(`SELECT id, name, job_title FROM users WHERE active = 1 AND id IN (${placeholders(ids)})`, ...ids);
      team = people
        .map((p) => ({ id: p.id, name: p.name, job_title: p.job_title, ...EMPTY_STATS, ...(stats.get(p.id) || {}) }))
        .sort((a, b) => b.blocked - a.blocked || b.overdue - a.overdue || a.name.localeCompare(b.name, 'ar'));
    }
  }

  return {
    generated_at: ts,
    scope: taskId ? 'task' : projectId ? 'project' : 'all',
    summary: summarize(tasks),
    tasks: tasks.map(({ assignee_id: _a, assignee_name: _n, ...t }) => t),
    team,
  };
}

module.exports = { TASK_FIELDS, TASK_FROM, placeholders, markOverdue, summarize, memberStats, workSnapshot, EMPTY_STATS };
