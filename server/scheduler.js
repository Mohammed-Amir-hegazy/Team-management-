'use strict';

// Fires task alarms: the reminder the user set, and an overdue alert once the deadline passes.

const { getUser, notify } = require('./access');

const DUE_REMINDERS = `
  SELECT * FROM tasks
  WHERE reminder_sent = 0 AND reminder_at IS NOT NULL AND reminder_at <= ? AND status != 'done'
`;
const DUE_OVERDUE = `
  SELECT * FROM tasks
  WHERE overdue_notified = 0 AND deadline IS NOT NULL AND deadline <= ? AND status != 'done'
`;

async function runReminders(db, at = new Date()) {
  const ts = at.toISOString();
  // Cheap read first so an idle tick never opens a write transaction.
  if (!(await db.get(`${DUE_REMINDERS} LIMIT 1`, ts)) && !(await db.get(`${DUE_OVERDUE} LIMIT 1`, ts))) return 0;

  return db.transaction(async (tx) => {
    let fired = 0;
    for (const task of await tx.all(DUE_REMINDERS, ts)) {
      await notify(tx, task.assignee_id, 'reminder', `⏰ تذكير بالمهمة «${task.title}»`, `#/tasks/${task.id}`);
      await tx.run('UPDATE tasks SET reminder_sent = 1 WHERE id = ?', task.id);
      fired++;
    }
    for (const task of await tx.all(DUE_OVERDUE, ts)) {
      const assignee = await getUser(tx, task.assignee_id);
      await notify(tx, task.assignee_id, 'overdue', `⚠️ انقضى الموعد النهائي للمهمة «${task.title}»`, `#/tasks/${task.id}`);
      if (assignee && assignee.supervisor_id) {
        await notify(tx, assignee.supervisor_id, 'overdue',
          `⚠️ انقضى الموعد النهائي للمهمة «${task.title}» المسندة إلى ${assignee.name}`, `#/tasks/${task.id}`);
      }
      await tx.run('UPDATE tasks SET overdue_notified = 1 WHERE id = ?', task.id);
      fired++;
    }
    return fired;
  });
}

function startScheduler(db, intervalMs = 30000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReminders(db);
      await db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
    } catch (err) {
      console.error('scheduler error:', err);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { runReminders, startScheduler };
