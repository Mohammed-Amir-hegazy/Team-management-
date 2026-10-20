'use strict';

const { now } = require('../db');
const v = require('../validate');
const { subordinateIds } = require('../access');

module.exports = function register(router) {
  router.get('/api/notifications', ({ db, user, query }) => {
    const afterId = Number(query.get('after')) || 0;
    const notifications = db.prepare(`
      SELECT * FROM notifications WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT 100
    `).all(user.id, afterId);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id);
    return { notifications, unread: n };
  });

  router.post('/api/notifications/read-all', ({ db, user }) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), user.id);
    return { ok: true };
  });

  router.post('/api/notifications/:id/read', ({ db, user, params }) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(now(), v.id(params.id, 'الإشعار'), user.id);
    return { ok: true };
  });

  router.get('/api/dashboard', ({ db, user }) => {
    const ts = now();
    const week = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const byStatus = {};
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE assignee_id = ? GROUP BY status').all(user.id)) {
      byStatus[row.status] = row.n;
    }
    const taskSql = `
      SELECT t.*, p.name AS project_name, u.name AS assignee_name FROM tasks t
      JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = t.assignee_id
    `;
    const overdue = db.prepare(`${taskSql} WHERE t.assignee_id = ? AND t.status != 'done' AND t.deadline < ? ORDER BY t.deadline`)
      .all(user.id, ts);
    const upcoming = db.prepare(`${taskSql} WHERE t.assignee_id = ? AND t.status != 'done' AND t.deadline >= ? AND t.deadline <= ? ORDER BY t.deadline`)
      .all(user.id, ts, week);

    const subs = [...subordinateIds(db, user.id)];
    let teamBlocked = [];
    let teamOverdue = [];
    if (subs.length) {
      const ph = subs.map(() => '?').join(',');
      teamBlocked = db.prepare(`${taskSql} WHERE t.assignee_id IN (${ph}) AND t.status = 'blocked' ORDER BY t.updated_at DESC`).all(...subs);
      teamOverdue = db.prepare(`${taskSql} WHERE t.assignee_id IN (${ph}) AND t.status != 'done' AND t.deadline < ? ORDER BY t.deadline`)
        .all(...subs, ts);
    }
    return {
      my_tasks_by_status: byStatus,
      overdue,
      upcoming,
      team_blocked: teamBlocked,
      team_overdue: teamOverdue,
      team_size: subs.length,
      unread_reports: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE recipient_id = ? AND read_at IS NULL').get(user.id).n,
      pending_requests: db.prepare("SELECT COUNT(*) AS n FROM requests WHERE recipient_id = ? AND status = 'pending'").get(user.id).n,
    };
  });
};
