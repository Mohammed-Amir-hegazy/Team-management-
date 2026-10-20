'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { runReminders } = require('../server/scheduler');

let server;
let base;
let db;

test.before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

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

test('setup and hierarchy', async (t) => {
  owner = client();
  assert.equal((await owner('GET', '/api/setup-status')).data.needsSetup, true);
  const r = await owner('POST', '/api/setup', { name: 'Owner', email: 'owner@x.com', password: 'secret123' });
  assert.equal(r.status, 200);
  people.owner = r.data.user;
  assert.equal((await owner('POST', '/api/setup', { name: 'B', email: 'b@x.com', password: 'secret123' })).status, 409);

  const add = async (c, body) => {
    const res = await c('POST', '/api/users', { password: 'secret123', ...body });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.user;
  };
  people.manager = await add(owner, { name: 'Manager', email: 'm@x.com', role: 'manager' });

  await t.test('supervisor must be exactly one level up', async () => {
    const bad = await owner('POST', '/api/users', {
      name: 'E', email: 'e0@x.com', password: 'secret123', role: 'employee', supervisor_id: people.manager.id,
    });
    assert.equal(bad.status, 400);
  });

  manager = await login('m@x.com');
  people.leader = await add(manager, { name: 'Leader', email: 'l@x.com', role: 'team_leader' });
  people.otherLeader = await add(manager, { name: 'Other Leader', email: 'l2@x.com', role: 'team_leader' });

  await t.test('cannot create someone at or above own level', async () => {
    const bad = await manager('POST', '/api/users', { name: 'X', email: 'x@x.com', password: 'secret123', role: 'manager' });
    assert.equal(bad.status, 403);
  });

  leader = await login('l@x.com');
  otherLeader = await login('l2@x.com');
  people.employee = await add(leader, { name: 'Employee', email: 'e@x.com', role: 'employee' });
  employee = await login('e@x.com');

  await t.test('leader cannot place an employee under another leader', async () => {
    const bad = await leader('POST', '/api/users', {
      name: 'Y', email: 'y@x.com', password: 'secret123', role: 'employee', supervisor_id: people.otherLeader.id,
    });
    assert.equal(bad.status, 403);
  });

  const me = await employee('GET', '/api/me');
  assert.equal(me.data.user.supervisor_name, 'Leader');
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
  assert.equal((await manager('GET', `/api/reports/${reportId}`)).status, 404);

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
  const fired = runReminders(db);
  assert.ok(fired >= 1);
  assert.equal(runReminders(db), 0, 'each alarm fires once');

  let notes = await employee('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n) => n.type === 'reminder'));

  runReminders(db, new Date(Date.now() + 2 * 3600 * 1000));
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
