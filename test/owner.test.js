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
