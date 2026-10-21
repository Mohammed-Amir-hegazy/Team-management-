'use strict';

// The platform owner (by email) with its two-step login, and companies registered by their system admin.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');

const sent = [];
const messenger = {
  channels: { email: true, sms: true, whatsapp: true },
  async sendCode(channel, data) {
    if (channel === 'whatsapp' && messenger.failWhatsapp) throw new Error('down');
    sent.push({ channel, ...data });
  },
};
const config = {
  cloudinary: null, defaultCountryCode: '20', allowSignup: true, trialDays: 30, trialSeats: 5,
  platformOwnerEmail: 'boss@ebtikar.co', platformOwnerPhone: '201018736900',
};

let server; let base; let db; let tmpDir;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-owner-'));
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

test('a company registered by its system admin, with the owner added later', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/signup', {
    company_name: 'Delta', name: 'Admin', email: 'admin@delta.co', password: 'secret123', creator_role: 'admin',
  })).status, 400, 'an admin also needs an organisational role');
  const r = await admin('POST', '/api/signup', {
    company_name: 'Delta', name: 'Admin', email: 'admin@delta.co', password: 'secret123', creator_role: 'admin', creator_level: 'manager',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'manager');
  assert.deepEqual([...r.data.user.roles].sort(), ['admin', 'manager']);
  assert.equal(r.data.user.is_platform, false);
  const me = (await admin('GET', '/api/me')).data.user;
  assert.equal(me.company.plan, 'trial');

  // The admin builds the team and then adds the owner — only one.
  const lead = (await admin('POST', '/api/users', {
    name: 'Lead', email: 'lead@delta.co', password: 'secret123', roles: ['team_leader'], supervisor_id: me.id,
  })).data.user;
  assert.equal(lead.supervisor_id, me.id);
  // Nobody is above a manager until the owner exists, so another manager starts at the top.
  const peer = await admin('POST', '/api/users', { name: 'Peer', email: 'peer@delta.co', password: 'secret123', roles: ['manager'], supervisor_id: null });
  assert.equal(peer.status, 200, JSON.stringify(peer.data));
  assert.equal(peer.data.user.supervisor_id, null);
  const owner = await admin('POST', '/api/users', { name: 'Owner', email: 'owner@delta.co', password: 'secret123', roles: ['owner'] });
  assert.equal(owner.status, 200, JSON.stringify(owner.data));
  assert.equal(owner.data.user.role, 'owner');
  assert.equal((await admin('POST', '/api/users', { name: 'O2', email: 'o2@delta.co', password: 'secret123', roles: ['owner'] })).status, 400);
  // The admin now reports to the owner; the lead still reports to the admin.
  assert.equal((await admin('GET', '/api/me')).data.user.supervisor_id, owner.data.user.id);
  const ownerC = client();
  assert.equal((await ownerC('POST', '/api/login', { email: 'owner@delta.co', password: 'secret123' })).status, 200);
  const users = (await ownerC('GET', '/api/users')).data.users;
  assert.equal(users.find((u) => u.id === lead.id).supervisor_id, me.id);
  assert.equal(users.find((u) => u.id === peer.data.user.id).supervisor_id, owner.data.user.id);
  // With an owner in place, everyone needs a direct supervisor again.
  assert.equal((await admin('POST', '/api/users', { name: 'M3', email: 'm3@delta.co', password: 'secret123', roles: ['manager'] })).status, 400);

  // Any employee may start a project of their own and add tasks to it; their supervisors follow it.
  const emp = (await admin('POST', '/api/users', {
    name: 'Emp', email: 'emp@delta.co', password: 'secret123', roles: ['employee'], supervisor_id: lead.id,
  })).data.user;
  const empC = client();
  await empC('POST', '/api/login', { email: 'emp@delta.co', password: 'secret123' });
  const proj = await empC('POST', '/api/projects', { name: 'My initiative' });
  assert.equal(proj.status, 200, JSON.stringify(proj.data));
  const t = await empC('POST', `/api/projects/${proj.data.project.id}/tasks`, { title: 'First step' });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.equal(t.data.task.assignee_id, emp.id);
  assert.equal((await empC('POST', `/api/projects/${proj.data.project.id}/tasks`, { title: 'x', assignee_id: lead.id })).status, 403);
  assert.ok((await admin('GET', '/api/projects')).data.projects.some((p) => p.id === proj.data.project.id), 'visible up the chain');
  assert.ok((await ownerC('GET', '/api/projects')).data.projects.some((p) => p.id === proj.data.project.id));
});

test('the platform owner is decided by email and signs in with a code', async () => {
  const boss = client();
  const r = await boss('POST', '/api/signup', { company_name: 'Ebtikar', name: 'Amir', email: 'Boss@Ebtikar.co', password: 'secret123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.is_platform, true);
  assert.equal((await boss('GET', '/api/me')).data.user.company.plan, 'owned');
  await boss('POST', '/api/logout');

  // Password alone is not enough: a code goes to the owner's phone on WhatsApp.
  sent.length = 0;
  const login = await boss('POST', '/api/login', { email: 'boss@ebtikar.co', password: 'secret123' });
  assert.equal(login.status, 200);
  assert.equal(login.data.two_factor, true);
  assert.equal(login.data.user, undefined);
  assert.equal(login.data.channel, 'whatsapp');
  assert.deepEqual(login.data.channels, ['whatsapp', 'sms', 'email']);
  assert.equal(sent[0].phone, '201018736900');
  assert.equal(sent[0].purpose, 'login');
  assert.ok(!login.data.destination.includes('1873'), 'the number is masked');
  assert.equal((await boss('GET', '/api/me')).status, 401, 'no session before the code');

  // Wrong codes count against the challenge.
  const wrong = await boss('POST', '/api/login/verify', { challenge: login.data.challenge, code: '000000' === sent[0].code ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  // Asking again too soon is refused.
  assert.equal((await boss('POST', '/api/login/resend', { challenge: login.data.challenge, channel: 'email' })).status, 429);
  const ok = await boss('POST', '/api/login/verify', { challenge: login.data.challenge, code: sent[0].code });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.user.is_platform, true);
  assert.equal((await boss('GET', '/api/platform/overview')).status, 200);
  // A code works once.
  assert.equal((await client()('POST', '/api/login/verify', { challenge: login.data.challenge, code: sent[0].code })).status, 400);
});

test('the code falls back to another channel and locks after too many tries', async () => {
  sent.length = 0;
  messenger.failWhatsapp = true;
  const c = client();
  const login = await c('POST', '/api/login', { email: 'boss@ebtikar.co', password: 'secret123' });
  messenger.failWhatsapp = false;
  assert.equal(login.data.channel, 'sms');
  // Chosen channel: email.
  const byMail = await client()('POST', '/api/login', { email: 'boss@ebtikar.co', password: 'secret123', channel: 'email' });
  assert.equal(byMail.data.channel, 'email');
  assert.equal(sent.at(-1).email, 'boss@ebtikar.co');
  for (let i = 0; i < 5; i++) await c('POST', '/api/login/verify', { challenge: byMail.data.challenge, code: '999999' === sent.at(-1).code ? '888888' : '999999' });
  assert.equal((await c('POST', '/api/login/verify', { challenge: byMail.data.challenge, code: sent.at(-1).code })).status, 400);
  // Others sign in with their password only.
  const other = await client()('POST', '/api/login', { email: 'admin@delta.co', password: 'secret123' });
  assert.equal(other.status, 200);
  assert.ok(other.data.user);
});

test('photos are kept by the platform itself when Cloudinary is not configured', async () => {
  const a = client();
  await a('POST', '/api/signup', { company_name: 'Pix', name: 'Pix Owner', email: 'o@pix.co', password: 'secret123' });
  const task = (await a('POST', '/api/tasks', { title: 'Shoot' })).data.task;
  const cfg = (await a('GET', '/api/client-config')).data;
  assert.equal(cfg.uploads, true);
  assert.equal((await a('POST', '/api/uploads/sign', { purpose: 'task', task_id: task.id })).data.mode, 'local');

  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2000, 7)]);
  const small = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(100, 3)]);
  const dataUrl = (b) => `data:image/jpeg;base64,${b.toString('base64')}`;
  assert.equal((await a('POST', '/api/uploads/image', { purpose: 'task', task_id: task.id, data: 'data:image/jpeg;base64,aGVsbG8=' })).status, 400, 'not really an image');
  const up = await a('POST', '/api/uploads/image', { purpose: 'task', task_id: task.id, data: dataUrl(jpeg), thumb: dataUrl(small), width: 800, height: 600 });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.match(up.data.url, /^\/api\/images\/[\w-]{20,}$/);
  // A photo larger than the 1 MB default body limit is accepted on this route.
  const big = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(1100 * 1024, 1)]);
  assert.equal((await a('POST', '/api/uploads/image', { purpose: 'report', data: dataUrl(big) })).status, 200);

  assert.equal((await a('POST', `/api/tasks/${task.id}/attachments`, { images: [{ url: '/api/images/made-up', public_id: 'x' }] })).status, 400);
  const att = await a('POST', `/api/tasks/${task.id}/attachments`, { images: [up.data], caption: 'Before' });
  assert.equal(att.status, 200, JSON.stringify(att.data));
  const shown = (await a('GET', `/api/tasks/${task.id}`)).data.attachments;
  assert.equal(shown[0].url, up.data.url);

  // Served to the company only; the thumbnail separately.
  const cookieOf = async (email) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123' }) });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const mine = await cookieOf('o@pix.co');
  const full = await fetch(base + up.data.url, { headers: { Cookie: mine } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(jpeg));
  const th = await fetch(`${base}${up.data.url}?size=thumb`, { headers: { Cookie: mine } });
  assert.ok(Buffer.from(await th.arrayBuffer()).equals(small));
  assert.equal((await fetch(base + up.data.url, { headers: { Cookie: await cookieOf('admin@delta.co') } })).status, 404);
  assert.equal((await fetch(base + up.data.url)).status, 401);

  // Unattached uploads are cleaned up; attached ones stay until their attachment is deleted.
  const { purgeOrphanImages } = require('../server/images');
  assert.equal(await purgeOrphanImages(db, -1000), 1, 'only the never-attached photo');
  assert.equal((await a('DELETE', `/api/attachments/${shown[0].id}`)).status, 200);
  assert.equal((await fetch(base + up.data.url, { headers: { Cookie: mine } })).status, 404);
});
