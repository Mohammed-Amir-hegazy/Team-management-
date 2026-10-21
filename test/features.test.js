'use strict';

// Password recovery, phone numbers, image attachments, standalone tasks and reminders.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { createMessenger } = require('../server/messaging');

const CLOUD = { cloud_name: 'ebtikar-test', api_key: 'key123', api_secret: 'secret456' };
const sentCodes = [];
const destroyed = [];
const messenger = {
  channels: { email: true, sms: false, whatsapp: true },
  async sendCode(channel, data) { sentCodes.push({ channel, ...data }); },
};
const config = {
  cloudinary: CLOUD,
  defaultCountryCode: '20',
  fetch: async (url, init) => { destroyed.push({ url, body: init.body }); return { ok: true }; },
};

let server; let base; let db; let tmpDir;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-features-'));
  db = await openDatabase(process.env.TEST_DATABASE_URL || `file:${path.join(tmpDir, 'test.db')}`);
  server = http.createServer(createApp(db, { config, messenger }));
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
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

async function login(email, password = 'secret123') {
  const c = client();
  const r = await c('POST', '/api/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

const people = {};
let owner; let leader; let otherLeader; let employee;
const image = (n) => ({ url: `https://res.cloudinary.com/${CLOUD.cloud_name}/image/upload/v1/ebtikar/x${n}.jpg`, public_id: `ebtikar/x${n}`, width: 800, height: 600 });

test('accounts with WhatsApp numbers', async () => {
  owner = client();
  const setup = await owner('POST', '/api/setup', { name: 'Owner', email: 'o@x.com', password: 'secret123', phone: '+20 100 000 0001' });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.user.phone, '201000000001');
  const add = async (body) => {
    const r = await owner('POST', '/api/users', { password: 'secret123', ...body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  people.leader = await add({ name: 'Leader', email: 'l@x.com', roles: ['team_leader'], supervisor_id: setup.data.user.id, phone: '01000000002' });
  assert.equal(people.leader.phone, '201000000002', 'local numbers get the default country code');
  people.other = await add({ name: 'Other', email: 'l2@x.com', roles: ['team_leader'], supervisor_id: setup.data.user.id });
  people.employee = await add({ name: 'Employee', email: 'e@x.com', roles: ['employee'], supervisor_id: people.leader.id });

  const dup = await owner('POST', '/api/users', { name: 'D', email: 'd@x.com', password: 'secret123', roles: ['employee'], supervisor_id: people.leader.id, phone: '201000000002' });
  assert.equal(dup.status, 409);
  const bad = await owner('POST', '/api/users', { name: 'D', email: 'd@x.com', password: 'secret123', roles: ['employee'], supervisor_id: people.leader.id, phone: '12' });
  assert.equal(bad.status, 400);

  leader = await login('l@x.com');
  otherLeader = await login('l2@x.com');
  employee = await login('e@x.com');
  assert.equal((await employee('PATCH', '/api/me', { phone: '00201000000003' })).data.user.phone, '201000000003');

  const me = await employee('GET', '/api/me');
  assert.deepEqual(me.data.user.chain.map((c) => c.name), ['Leader', 'Owner']);
  assert.equal(me.data.user.chain[0].phone, '201000000002');

  const cfg = await client()('GET', '/api/client-config');
  assert.deepEqual(cfg.data.otp, messenger.channels);
  assert.equal(cfg.data.uploads, true);
});

test('forgot password with a one-time code', async () => {
  const anon = client();
  assert.equal((await anon('POST', '/api/password/forgot', { identifier: 'e@x.com', channel: 'sms' })).status, 400, 'disabled channel');

  // Unknown accounts get the same answer and nothing is sent.
  const unknown = await anon('POST', '/api/password/forgot', { identifier: 'nobody@x.com', channel: 'email' });
  assert.equal(unknown.status, 200);
  assert.equal(sentCodes.length, 0);

  const r = await anon('POST', '/api/password/forgot', { identifier: 'e@x.com', channel: 'email' });
  assert.equal(r.status, 200);
  assert.equal(sentCodes.length, 1);
  const { code } = sentCodes[0];
  assert.match(code, /^\d{6}$/);
  assert.equal(sentCodes[0].email, 'e@x.com');

  assert.equal((await anon('POST', '/api/password/forgot', { identifier: 'e@x.com', channel: 'email' })).status, 429, 'resend too soon');

  const wrong = await anon('POST', '/api/password/reset', { identifier: 'e@x.com', code: code === '000000' ? '111111' : '000000', new_password: 'newpass1' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /المحاولات المتبقية: 4/);

  const ok = await anon('POST', '/api/password/reset', { identifier: 'e@x.com', code, new_password: 'newpass1' });
  assert.equal(ok.status, 200);
  assert.equal((await anon('GET', '/api/me')).status, 200, 'signed in after reset');
  assert.equal((await employee('GET', '/api/me')).status, 401, 'other sessions signed out');
  assert.equal((await client()('POST', '/api/login', { email: 'e@x.com', password: 'secret123' })).status, 401);
  employee = await login('e@x.com', 'newpass1');
  assert.equal((await anon('POST', '/api/password/reset', { identifier: 'e@x.com', code, new_password: 'again12' })).status, 400, 'codes are single-use');

  // By phone number over WhatsApp, written in local format.
  await anon('POST', '/api/password/forgot', { identifier: '01000000002', channel: 'whatsapp' });
  const last = sentCodes.at(-1);
  assert.equal(last.channel, 'whatsapp');
  assert.equal(last.phone, '201000000002');

  // Five wrong guesses burn the code.
  for (let i = 0; i < 5; i++) await anon('POST', '/api/password/reset', { identifier: '01000000002', code: '999999' === last.code ? '888888' : '999999', new_password: 'x123456' });
  const burned = await anon('POST', '/api/password/reset', { identifier: '01000000002', code: last.code, new_password: 'x123456' });
  assert.equal(burned.status, 400);
});

let project; let task;

test('standalone tasks live outside projects', async () => {
  const own = await employee('POST', '/api/tasks', { title: 'Weekly backup' });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal(own.data.task.standalone, 1);
  assert.equal(own.data.task.assignee_id, people.employee.id);

  assert.equal((await employee('GET', '/api/projects')).data.projects.length, 0, 'container is hidden');
  assert.equal((await leader('GET', `/api/tasks/${own.data.task.id}`)).status, 200, 'supervisor can follow it');
  assert.equal((await otherLeader('GET', `/api/tasks/${own.data.task.id}`)).status, 404);

  const assigned = await leader('POST', '/api/tasks', { title: 'Call the client', assignee_id: people.employee.id });
  assert.equal(assigned.data.task.project_id, own.data.task.project_id, 'goes to the assignee’s standalone tasks');
  assert.equal((await employee('POST', '/api/tasks', { title: 'x', assignee_id: people.leader.id })).status, 403);

  // An employee can also add a task for themselves inside a project they belong to.
  const p = await leader('POST', '/api/projects', { name: 'Site', member_ids: [people.employee.id] });
  project = p.data.project;
  const inProject = await employee('POST', `/api/projects/${project.id}/tasks`, { title: 'Hero section' });
  assert.equal(inProject.status, 200);
  assert.equal(inProject.data.task.standalone, 0);
  task = inProject.data.task;

  const detail = await employee('GET', `/api/tasks/${own.data.task.id}`);
  assert.equal(detail.data.project.standalone, true);
  const container = await employee('GET', `/api/projects/${own.data.task.project_id}`);
  assert.equal(container.data.permissions.manage, false);
  assert.equal(container.data.permissions.add_members, false);
});

test('images via Cloudinary, shown on the task and in reports', async () => {
  const sig = await employee('POST', '/api/uploads/sign', { purpose: 'task', task_id: task.id });
  assert.equal(sig.status, 200);
  const expected = crypto.createHash('sha1').update(`folder=${sig.data.folder}&timestamp=${sig.data.timestamp}${CLOUD.api_secret}`).digest('hex');
  assert.equal(sig.data.signature, expected);
  assert.equal(sig.data.api_key, CLOUD.api_key);
  assert.equal(sig.data.api_secret, undefined, 'secret never leaves the server');
  assert.equal((await otherLeader('POST', '/api/uploads/sign', { purpose: 'task', task_id: task.id })).status, 404);

  const foreign = await employee('POST', `/api/tasks/${task.id}/attachments`, { images: [{ url: 'https://evil.example/x.jpg', public_id: 'x' }] });
  assert.equal(foreign.status, 400);
  const added = await employee('POST', `/api/tasks/${task.id}/attachments`, { images: [image(1), image(2)], caption: 'Draft screens' });
  assert.equal(added.status, 200);
  const detail = await employee('GET', `/api/tasks/${task.id}`);
  assert.equal(detail.data.attachments.length, 2);
  assert.equal(detail.data.attachments[0].caption, 'Draft screens');

  const sent = await employee('POST', '/api/reports', { title: 'Progress', body: 'See screens', images: [image(3)] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const view = await leader('GET', `/api/reports/${sent.data.report.id}`);
  assert.equal(view.data.report.images.length, 1);
  const snapTask = view.data.report.snapshot.tasks.find((t) => t.id === task.id);
  assert.equal(snapTask.images.length, 2);

  const attachmentId = detail.data.attachments[0].id;
  assert.equal((await otherLeader('DELETE', `/api/attachments/${attachmentId}`)).status, 404);
  assert.equal((await employee('DELETE', `/api/attachments/${attachmentId}`)).status, 200);
  assert.equal(destroyed.length, 1);
  assert.match(destroyed[0].url, /ebtikar-test\/image\/destroy/);
});

test('reminders ring for the right people only', async () => {
  const nudge = await leader('POST', `/api/tasks/${task.id}/remind`, { message: 'Please finish today' });
  assert.equal(nudge.status, 200, JSON.stringify(nudge.data));
  const notes = await employee('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n) => n.type === 'nudge' && n.message.includes('Please finish today')));
  assert.equal((await leader('POST', `/api/tasks/${task.id}/remind`, {})).status, 429, 'rate limited');
  assert.equal((await employee('POST', `/api/tasks/${task.id}/remind`, {})).status, 403, 'assignee cannot nudge themselves');

  // Employee reminds their supervisor about a pending request.
  await employee('POST', `/api/tasks/${task.id}/requirements`, { description: 'Laptop' });
  const req = await employee('POST', `/api/tasks/${task.id}/requirements/send`, {});
  assert.equal((await employee('POST', `/api/requests/${req.data.request_id}/remind`, {})).status, 200);
  assert.equal((await leader('POST', `/api/requests/${req.data.request_id}/remind`, {})).status, 403);
  const detail = await employee('GET', `/api/requests/${req.data.request_id}`);
  assert.equal(detail.data.request.recipient_phone, '201000000002');

  // General reminders only between related people.
  assert.equal((await employee('POST', `/api/users/${people.leader.id}/remind`, { message: 'Meeting at 3' })).status, 200);
  assert.equal((await employee('POST', `/api/users/${people.other.id}/remind`, { message: 'Hi' })).status, 403);
});

test('messenger builds the provider requests', async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  const m = createMessenger({
    BREVO_API_KEY: 'bk', MAIL_FROM: 'no-reply@ebtikar.co',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886', TWILIO_SMS_FROM: '+15550001111',
  }, fake);
  assert.deepEqual(m.channels, { email: true, sms: true, whatsapp: true });
  await m.sendCode('email', { email: 'a@b.com', name: 'A', code: '123456', minutes: 10 });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  const mail = JSON.parse(calls[0].init.body);
  assert.equal(mail.to[0].email, 'a@b.com');
  assert.ok(mail.htmlContent.includes('123456'));
  await m.sendCode('whatsapp', { phone: '201000000002', name: 'A', code: '654321', minutes: 10 });
  const form = new URLSearchParams(calls[1].init.body);
  assert.equal(form.get('To'), 'whatsapp:+201000000002');
  assert.equal(form.get('From'), 'whatsapp:+14155238886');
  assert.ok(form.get('Body').includes('654321'));
  await m.sendCode('sms', { phone: '201000000002', name: 'A', code: '111222', minutes: 10 });
  assert.equal(new URLSearchParams(calls[2].init.body).get('To'), '+201000000002');

  const off = createMessenger({}, fake);
  assert.deepEqual(off.channels, { email: false, sms: false, whatsapp: false });
});
