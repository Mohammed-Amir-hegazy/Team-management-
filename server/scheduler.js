'use strict';

// Fires task alarms: the reminder the user set, and an overdue alert once the deadline passes.

const { transaction } = require('./db');
const { getUser, notify } = require('./access');

function runReminders(db, at = new Date()) {
  const ts = at.toISOString();
  let fired = 0;
  transaction(db, () => {
    const due = db.prepare(`
      SELECT * FROM tasks
      WHERE reminder_at IS NOT NULL AND reminder_sent = 0 AND reminder_at <= ? AND status != 'done'
    `).all(ts);
    for (const task of due) {
      notify(db, task.assignee_id, 'reminder', `⏰ تذكير بالتاسك "${task.title}"`, `#/tasks/${task.id}`);
      db.prepare('UPDATE tasks SET reminder_sent = 1 WHERE id = ?').run(task.id);
      fired++;
    }

    const overdue = db.prepare(`
      SELECT * FROM tasks
      WHERE deadline IS NOT NULL AND overdue_notified = 0 AND deadline <= ? AND status != 'done'
    `).all(ts);
    for (const task of overdue) {
      const assignee = getUser(db, task.assignee_id);
      notify(db, task.assignee_id, 'overdue', `⚠️ عدّى الديدلاين بتاع التاسك "${task.title}"`, `#/tasks/${task.id}`);
      if (assignee && assignee.supervisor_id) {
        notify(db, assignee.supervisor_id, 'overdue',
          `⚠️ التاسك "${task.title}" مع ${assignee.name} عدّت الديدلاين`, `#/tasks/${task.id}`);
      }
      db.prepare('UPDATE tasks SET overdue_notified = 1 WHERE id = ?').run(task.id);
      fired++;
    }
  });
  return fired;
}

function startScheduler(db, intervalMs = 15000) {
  const tick = () => {
    try {
      runReminders(db);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    } catch (err) {
      console.error('scheduler error:', err);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { runReminders, startScheduler };
