'use strict';

const { now } = require('../db');
const v = require('../validate');
const { subordinateIds, isAdmin } = require('../access');
const { releasesFor } = require('../releases');
const { runRecurringSoon } = require('./recurring');

const TASK_SQL = `
  SELECT t.*, CASE WHEN p.personal_owner_id IS NULL THEN p.name ELSE 'مهمة مستقلة' END AS project_name, u.name AS assignee_name FROM tasks t
  JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = t.assignee_id
`;


module.exports = function register(router) {
  // What changed in each platform update, with the steps owners and admins need to take.
  router.get('/api/releases', ({ user }) => ({ releases: releasesFor(isAdmin(user)) }), { ungated: true });

  // Polled by the browser: latest notifications plus the sidebar badge counters, in two queries.
  router.get('/api/notifications', async ({ db, user }) => {
    // Polled by every open app: also the moment to create recurring follow-ups that came due.
    runRecurringSoon(db);
    const notifications = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id);
    const counts = await db.get(`
      SELECT
        (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL) AS unread,
        (SELECT COUNT(*) FROM reports WHERE recipient_id = ? AND read_at IS NULL) AS unread_reports,
        (SELECT COUNT(*) FROM requests WHERE recipient_id = ? AND status = 'pending') AS pending_requests,
        (SELECT COUNT(*) FROM work_requests WHERE recipient_id = ? AND status = 'pending') AS pending_asks
    `, user.id, user.id, user.id, user.id);
    return { notifications, ...counts };
  }, { ungated: true });

  router.post('/api/notifications/read-all', async ({ db, user }) => {
    await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), user.id);
    return { ok: true };
  }, { ungated: true });

  router.post('/api/notifications/:id/read', async ({ db, user, params }) => {
    await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
      now(), v.id(params.id, 'الإشعار'), user.id);
    return { ok: true };
  }, { ungated: true });

  router.get('/api/dashboard', async ({ db, user }) => {
    const ts = now();
    const week = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const byStatus = {};
    for (const row of await db.all('SELECT status, COUNT(*) AS n FROM tasks WHERE assignee_id = ? GROUP BY status', user.id)) {
      byStatus[row.status] = row.n;
    }
    const mine = await db.all(`${TASK_SQL} WHERE t.assignee_id = ? AND t.status != 'done' AND t.deadline <= ? ORDER BY t.deadline`,
      user.id, week);

    const subs = [...(await subordinateIds(db, user.id))];
    let teamBlocked = [];
    let teamOverdue = [];
    if (subs.length) {
      const ph = subs.map(() => '?').join(',');
      const team = await db.all(`
        ${TASK_SQL} WHERE t.assignee_id IN (${ph})
          AND (t.status = 'blocked' OR (t.status != 'done' AND t.deadline < ?))
        ORDER BY t.deadline
      `, ...subs, ts);
      teamBlocked = team.filter((t) => t.status === 'blocked');
      teamOverdue = team.filter((t) => t.status !== 'done' && t.deadline && t.deadline < ts);
    }
    const counts = await db.get(`
      SELECT
        (SELECT COUNT(*) FROM reports WHERE recipient_id = ? AND read_at IS NULL) AS unread_reports,
        (SELECT COUNT(*) FROM requests WHERE recipient_id = ? AND status = 'pending') AS pending_requests,
        (SELECT COUNT(*) FROM work_requests WHERE recipient_id = ? AND status = 'pending') AS pending_asks
    `, user.id, user.id, user.id);
    // First steps for a new company, shown to its owner and admins until they are done.
    const setup = isAdmin(user) ? await db.get(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE company_id = ? AND active = 1 AND deleted_at IS NULL) AS users,
        (SELECT COUNT(*) FROM projects WHERE company_id = ? AND personal_owner_id IS NULL) AS projects,
        (SELECT COUNT(*) FROM company_brands WHERE company_id = ?) AS brand,
        (SELECT COUNT(*) FROM users WHERE company_id = ? AND active = 1 AND deleted_at IS NULL AND gender = '') AS no_gender
    `, user.company_id, user.company_id, user.company_id, user.company_id) : null;
    return {
      setup,
      my_tasks_by_status: byStatus,
      overdue: mine.filter((t) => t.deadline < ts),
      upcoming: mine.filter((t) => t.deadline >= ts),
      team_blocked: teamBlocked,
      team_overdue: teamOverdue,
      team_size: subs.length,
      ...counts,
    };
  });
};
