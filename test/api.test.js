'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { runReminders } = require('../server/scheduler');

let server;
let base;
let db;
let tmpDir;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-test-'));
  // TEST_DATABASE_URL runs the suite against a libSQL server (e.g. http://127.0.0.1:8080) instead of a file.
  db = await openDatabase(process.env.TEST_DATABASE_URL || `file:${path.join(tmpDir, 'test.db')}`);
  server = http.createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await res.json();
    return { status: res.status, data };
  };
}

async function login(email) {
  const c = client();
  const r = await c('POST', '/api/login', { email, password: 'secret123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

// owner -> manager -> leader -> employee, plus a second branch to check isolation.
const people = {};
let owner, manager, leader, employee, otherLeader;

test('setup, accounts and hierarchy', async (t) => {
  owner = client();
  assert.equal((await owner('GET', '/api/setup-status')).data.needsSetup, true);
  const r = await owner('POST', '/api/setup', { name: 'Owner', email: 'owner@x.com', password: 'secret123', job_title: 'CEO' });
  assert.equal(r.status, 200);
  people.owner = r.data.user;
  assert.ok(people.owner.is_admin);
  assert.equal((await owner('POST', '/api/setup', { name: 'B', email: 'b@x.com', password: 'secret123' })).status, 409);

  const add = async (c, body) => {
    const res = await c('POST', '/api/users', { password: 'secret123', ...body });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.user;
  };
  people.manager = await add(owner, { name: 'Manager', email: 'm@x.com', roles: ['manager'], supervisor_id: people.owner.id, job_title: 'مدير العمليات' });
  people.leader = await add(owner, { name: 'Leader', email: 'l@x.com', roles: ['team_leader', 'employee'], supervisor_id: people.manager.id, job_title: 'Frontend Lead' });
  people.otherLeader = await add(owner, { name: 'Other Leader', email: 'l2@x.com', roles: ['team_leader'], supervisor_id: people.manager.id });
  people.employee = await add(owner, { name: 'Employee', email: 'e@x.com', roles: ['employee'], supervisor_id: people.leader.id, job_title: 'مصمم واجهات' });
  manager = await login('m@x.com');
  leader = await login('l@x.com');
  otherLeader = await login('l2@x.com');
  employee = await login('e@x.com');

  await t.test('several roles and a job title per person', () => {
    assert.deepEqual(people.leader.roles, ['team_leader', 'employee']);
    assert.equal(people.leader.role, 'team_leader');
    assert.equal(people.employee.job_title, 'مصمم واجهات');
  });

  await t.test('only the owner or a system admin creates accounts', async () => {
    const bad = await manager('POST', '/api/users', {
      name: 'X', email: 'x@x.com', password: 'secret123', roles: ['employee'], supervisor_id: people.manager.id,
    });
    assert.equal(bad.status, 403);
    const it = await add(owner, { name: 'IT', email: 'it@x.com', roles: ['employee', 'admin'], supervisor_id: people.leader.id });
    const itClient = await login('it@x.com');
    const made = await itClient('POST', '/api/users', {
      name: 'Y', email: 'y@x.com', password: 'secret123', roles: ['employee'], supervisor_id: people.otherLeader.id,
    });
    assert.equal(made.status, 200);
    assert.equal((await itClient('PATCH', `/api/users/${people.owner.id}`, { name: 'Hacked' })).status, 403);
    assert.equal((await owner('PATCH', `/api/users/${made.data.user.id}`, { active: false })).status, 200);
    assert.equal((await owner('PATCH', `/api/users/${it.id}`, { active: false })).status, 200);
  });

  await t.test('supervisor must be at a higher level and never below', async () => {
    const same = await owner('POST', '/api/users', {
      name: 'E', email: 'e0@x.com', password: 'secret123', roles: ['team_leader'], supervisor_id: people.leader.id,
    });
    assert.equal(same.status, 400);
    const noLevel = await owner('POST', '/api/users', {
      name: 'E', email: 'e1@x.com', password: 'secret123', roles: ['admin'], supervisor_id: people.leader.id,
    });
    assert.equal(noLevel.status, 400);
    // Demoting the manager below their own team leaders is refused.
    const demote = await owner('PATCH', `/api/users/${people.manager.id}`, { roles: ['employee'] });
    assert.equal(demote.status, 400);
  });

  const me = await employee('GET', '/api/me');
  assert.equal(me.data.user.supervisor_name, 'Leader');
  assert.equal(me.data.user.has_team, false);
  assert.equal((await leader('GET', '/api/me')).data.user.has_team, true);
});

let project;
let task;

test('projects and tasks', async () => {
  const p = await manager('POST', '/api/projects', {
    name: 'Website', description: 'New site', member_ids: [people.leader.id],
  });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  project = p.data.project;

  assert.equal((await employee('POST', '/api/projects', { name: 'Nope' })).status, 403);

  // Leader assigns to their employee; the employee is auto-added to the project.
  const deadline = new Date(Date.now() + 3600 * 1000).toISOString();
  const tr = await leader('POST', `/api/projects/${project.id}/tasks`, {
    title: 'Landing page', assignee_id: people.employee.id, deadline,
    reminder_at: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(tr.status, 200, JSON.stringify(tr.data));
  task = tr.data.task;

  const list = await employee('GET', '/api/projects');
  assert.deepEqual(list.data.projects.map((x) => x.id), [project.id]);

  // Other branch cannot see it or assign into it.
  assert.equal((await otherLeader('GET', `/api/projects/${project.id}`)).status, 404);
  assert.equal((await otherLeader('GET', `/api/tasks/${task.id}`)).status, 404);

  // Leader cannot assign to someone outside their subtree.
  const bad = await leader('POST', `/api/projects/${project.id}/tasks`, { title: 'x', assignee_id: people.manager.id });
  assert.equal(bad.status, 403);

  // Reminder must not be after the deadline.
  const badReminder = await leader('POST', `/api/projects/${project.id}/tasks`, {
    title: 'x', deadline, reminder_at: new Date(Date.now() + 7200 * 1000).toISOString(),
  });
  assert.equal(badReminder.status, 400);
});

test('task status with a reason', async () => {
  const noReason = await employee('POST', `/api/tasks/${task.id}/status`, { status: 'blocked' });
  assert.equal(noReason.status, 400);

  const blocked = await employee('POST', `/api/tasks/${task.id}/status`, { status: 'blocked', note: 'Waiting for design' });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.data.task.status_note, 'Waiting for design');

  const detail = await leader('GET', `/api/tasks/${task.id}`);
  assert.equal(detail.data.history[0].to_status, 'blocked');
  assert.equal(detail.data.history[0].note, 'Waiting for design');

  const notes = await leader('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n) => n.type === 'blocked'));

  const dash = await manager('GET', '/api/dashboard');
  assert.equal(dash.data.team_blocked.length, 1);

  // An employee cannot edit task details, only the status/reminder.
  assert.equal((await employee('PATCH', `/api/tasks/${task.id}`, { title: 'Hacked' })).status, 403);
  assert.equal((await employee('PATCH', `/api/tasks/${task.id}`, { reminder_at: null })).status, 200);
});

test('reports only go to the direct supervisor', async () => {
  const skip = await employee('POST', '/api/reports', { title: 'Hi', body: 'skip', recipient_id: people.manager.id });
  assert.equal(skip.status, 403);

  const ok = await employee('POST', '/api/reports', { title: 'Weekly', body: 'Done 3 pages', task_id: task.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.report.recipient_id, people.leader.id);
  const reportId = ok.data.report.id;

  assert.equal((await manager('GET', '/api/reports')).data.reports.length, 0);
  // Not in the manager's inbox, but readable by them (read-only) since the sender is in their team.
  const managerView = await manager('GET', `/api/reports/${reportId}`);
  assert.equal(managerView.status, 200);
  assert.equal(managerView.data.permissions.reply, false);
  assert.equal((await otherLeader('GET', `/api/reports/${reportId}`)).status, 404);

  const inbox = await leader('GET', '/api/reports');
  assert.equal(inbox.data.reports.length, 1);

  assert.equal((await leader('POST', `/api/reports/${reportId}/reply`, { reply: 'Thanks' })).status, 200);
  const fwd = await leader('POST', `/api/reports/${reportId}/forward`, { note: 'FYI' });
  assert.equal(fwd.status, 200);
  const mInbox = await manager('GET', '/api/reports');
  assert.equal(mInbox.data.reports[0].sender_id, people.leader.id);

  // The owner has nobody above.
  assert.equal((await owner('POST', '/api/reports', { title: 'x', body: 'y' })).status, 400);
});

test('requirements are sent in one click, per task or per project', async () => {
  const t2 = await leader('POST', `/api/projects/${project.id}/tasks`, { title: 'Backend', assignee_id: people.employee.id });
  for (const d of ['Laptop', 'Figma license']) {
    assert.equal((await employee('POST', `/api/tasks/${task.id}/requirements`, { description: d })).status, 200);
  }
  await employee('POST', `/api/tasks/${t2.data.task.id}/requirements`, { description: 'Server access', quantity: '1' });

  // Drafts are private.
  const leaderView = await leader('GET', `/api/tasks/${task.id}`);
  assert.equal(leaderView.data.requirements.length, 0);

  const sentTask = await employee('POST', `/api/tasks/${task.id}/requirements/send`, {});
  assert.equal(sentTask.status, 200);
  assert.equal(sentTask.data.count, 2);
  assert.equal((await employee('POST', `/api/tasks/${task.id}/requirements/send`, {})).status, 400);

  await employee('POST', `/api/tasks/${task.id}/requirements`, { description: 'Mouse' });
  const sentProject = await employee('POST', `/api/projects/${project.id}/requirements/send`, { note: 'all of them' });
  assert.equal(sentProject.data.count, 2);

  const inbox = await leader('GET', '/api/requests');
  assert.equal(inbox.data.requests.length, 2);
  assert.ok(inbox.data.requests.every((r) => r.recipient_id === people.leader.id));
  assert.equal((await manager('GET', '/api/requests')).data.requests.length, 0);

  // Leader forwards one request up a level; the manager's answer flows back to the employee.
  const projectReq = inbox.data.requests.find((r) => r.scope === 'project');
  const fwd = await leader('POST', `/api/requests/${projectReq.id}/forward`, { note: 'need budget' });
  assert.equal(fwd.status, 200);
  const mDetail = await manager('GET', `/api/requests/${fwd.data.request_id}`);
  assert.equal(mDetail.data.items.length, 2);
  assert.equal(mDetail.data.chain.length, 2);

  assert.equal((await manager('POST', `/api/requests/${fwd.data.request_id}/respond`, { decision: 'approved' })).status, 200);
  const original = await employee('GET', `/api/requests/${projectReq.id}`);
  assert.equal(original.data.request.status, 'approved');

  const taskReq = inbox.data.requests.find((r) => r.scope === 'task');
  assert.equal((await leader('POST', `/api/requests/${taskReq.id}/respond`, { decision: 'rejected' })).status, 400);
  assert.equal((await leader('POST', `/api/requests/${taskReq.id}/respond`, { decision: 'rejected', note: 'no budget' })).status, 200);
  const view = await employee('GET', `/api/tasks/${task.id}`);
  assert.ok(view.data.requirements.some((r) => r.request_status === 'rejected'));
});

test('reminder and overdue alarms', async () => {
  await leader('PATCH', `/api/tasks/${task.id}`, {
    reminder_at: new Date(Date.now() - 1000).toISOString(),
    deadline: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  const fired = await runReminders(db);
  assert.ok(fired >= 1);
  assert.equal(await runReminders(db), 0, 'each alarm fires once');

  let notes = await employee('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n) => n.type === 'reminder'));

  await runReminders(db, new Date(Date.now() + 2 * 3600 * 1000));
  notes = await employee('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n) => n.type === 'overdue'));
  const leaderNotes = await leader('GET', '/api/notifications');
  assert.ok(leaderNotes.data.notifications.some((n) => n.type === 'overdue'));
});

test('auth guards', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/projects')).status, 401);
  const res = await fetch(`${base}/api/login`, { method: 'POST', body: 'email=a' });
  assert.equal(res.status, 415);
  assert.equal((await anon('POST', '/api/login', { email: 'e@x.com', password: 'wrong' })).status, 401);
});

test('deleting a task and a project removes everything under them', async () => {
  const p = await manager('POST', '/api/projects', { name: 'Temp', member_ids: [people.leader.id] });
  const pid = p.data.project.id;
  const t1 = await leader('POST', `/api/projects/${pid}/tasks`, { title: 'A', assignee_id: people.employee.id });
  const t2 = await leader('POST', `/api/projects/${pid}/tasks`, { title: 'B', assignee_id: people.employee.id });
  for (const t of [t1, t2]) {
    await employee('POST', `/api/tasks/${t.data.task.id}/requirements`, { description: 'thing' });
  }
  await employee('POST', `/api/tasks/${t1.data.task.id}/requirements/send`, {});
  const reqs = await leader('GET', '/api/requests');
  const sent = reqs.data.requests.find((r) => r.task_id === t1.data.task.id);
  await leader('POST', `/api/requests/${sent.id}/forward`, {});
  await employee('POST', '/api/reports', { title: 'r', body: 'b', task_id: t2.data.task.id });

  // Employee cannot delete; leader (creator) can.
  assert.equal((await employee('DELETE', `/api/tasks/${t1.data.task.id}`)).status, 403);
  assert.equal((await leader('DELETE', `/api/tasks/${t1.data.task.id}`)).status, 200);
  assert.equal((await leader('GET', `/api/tasks/${t1.data.task.id}`)).status, 404);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM requests WHERE task_id = ?', t1.data.task.id)).n, 0);

  assert.equal((await leader('DELETE', `/api/projects/${pid}`)).status, 403);
  assert.equal((await manager('DELETE', `/api/projects/${pid}`)).status, 200);
  for (const table of ['tasks', 'requests', 'project_members']) {
    assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, pid)).n, 0, table);
  }
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM requirements WHERE task_id = ?', t2.data.task.id)).n, 0);
  // The report survives, just detached from the deleted task.
  const sentReports = await employee('GET', '/api/reports?box=sent');
  assert.ok(sentReports.data.reports.some((r) => r.title === 'r' && r.task_id === null));
});

test('reports carry the full work status and leaders see their team', async () => {
  const p = await manager('POST', '/api/projects', { name: 'Status', member_ids: [people.leader.id] });
  const pid = p.data.project.id;
  const t1 = await leader('POST', `/api/projects/${pid}/tasks`, { title: 'Open one', assignee_id: people.employee.id });
  await employee('POST', `/api/tasks/${t1.data.task.id}/status`, { status: 'blocked', note: 'Waiting for access' });

  const preview = await employee('GET', `/api/reports/preview?project_id=${pid}`);
  assert.equal(preview.data.snapshot.summary.blocked, 1);

  const sent = await employee('POST', '/api/reports', { title: 'Daily', body: 'Status', project_id: pid });
  const report = sent.data.report;
  assert.equal(report.snapshot.tasks[0].status_note, 'Waiting for access');

  // Leader's report includes a per-person summary of their team.
  const up = await leader('POST', '/api/reports', { title: 'Team daily', body: 'All good' });
  const leaderSnap = up.data.report.snapshot;
  assert.ok(leaderSnap.team.some((m) => m.name === 'Employee' && m.blocked >= 1));

  // The manager can read the employee's report (sent to the leader) through the team box, read-only.
  const teamBox = await manager('GET', '/api/reports?box=team');
  assert.ok(teamBox.data.reports.some((r) => r.id === report.id));
  const view = await manager('GET', `/api/reports/${report.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.permissions.reply, false);
  assert.equal((await otherLeader('GET', `/api/reports/${report.id}`)).status, 404);

  // Team task list, filtered to one person.
  const one = await manager('GET', `/api/tasks?scope=team&assignee=${people.employee.id}&status=blocked`);
  assert.ok(one.data.tasks.length >= 1);
  assert.equal((await leader('GET', `/api/tasks?scope=team&assignee=${people.otherLeader.id}`)).status, 403);

  // One-click team report.
  const tr = await leader('GET', '/api/team-report');
  assert.equal(tr.status, 200);
  assert.ok(tr.data.members.some((m) => m.name === 'Employee' && m.stats.blocked >= 1));
  assert.ok(tr.data.reports.some((r) => r.id === report.id));
  assert.equal((await employee('GET', '/api/team-report')).status, 403);
});
