'use strict';

// Multi-company platform: isolation, trial signup, seats, expiry, renewal, ownership, reminders.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { runSubscriptionReminders } = require('../server/subscription');

const DAY = 24 * 3600 * 1000;
const config = { cloudinary: null, defaultCountryCode: '20', allowSignup: true, trialDays: 30, trialSeats: 3, platformContact: { phone: '', email: '' } };
const messenger = { channels: { email: false, sms: false, whatsapp: false }, async sendCode() {} };

let server; let base; let db; let tmpDir;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-platform-'));
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

let platform; let acme; let acmeId; let ebtikarProject;

test('setup creates the platform owner and its perpetual company', async () => {
  platform = client();
  const r = await platform('POST', '/api/setup', { name: 'محمد أمير', email: 'amir@ebtikar.co', password: 'secret123', company_name: 'ابتكار' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.is_platform, true);
  const me = await platform('GET', '/api/me');
  assert.equal(me.data.user.company.name, 'ابتكار');
  assert.equal(me.data.user.company.plan, 'owned');
  assert.equal(me.data.user.company.ok, true);
  ebtikarProject = (await platform('POST', '/api/projects', { name: 'Internal' })).data.project;
});

test('a company signs up with a one-month trial and sees only its own data', async () => {
  acme = client();
  const r = await acme('POST', '/api/signup', {
    company_name: 'Acme', name: 'Acme Owner', email: 'owner@acme.co', password: 'secret123', phone: '01011111111',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.is_platform, false);
  const me = (await acme('GET', '/api/me')).data.user;
  acmeId = me.company.id;
  assert.equal(me.company.plan, 'trial');
  assert.ok(me.company.days_left >= 29 && me.company.days_left <= 30);

  // Isolation: nothing from the first company leaks.
  assert.equal((await acme('GET', '/api/projects')).data.projects.length, 0);
  assert.equal((await acme('GET', `/api/projects/${ebtikarProject.id}`)).status, 404);
  const users = (await acme('GET', '/api/users')).data.users;
  assert.deepEqual(users.map((u) => u.name), ['Acme Owner']);
  const platformUser = (await platform('GET', '/api/users')).data.users.find((u) => u.name === 'محمد أمير');
  const placed = await acme('POST', '/api/users', { name: 'X', email: 'x@acme.co', password: 'secret123', roles: ['employee'], supervisor_id: platformUser.id });
  assert.equal(placed.status, 400, 'cannot place people under another company’s user');

  // The platform owner is told about the new company.
  const notes = await platform('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n) => n.message.includes('Acme')));
});

test('accounts are limited by the plan’s seats', async () => {
  const me = (await acme('GET', '/api/me')).data.user;
  const add = (n) => acme('POST', '/api/users', { name: `Emp ${n}`, email: `e${n}@acme.co`, password: 'secret123', roles: ['employee'], supervisor_id: me.id });
  assert.equal((await add(1)).status, 200);
  assert.equal((await add(2)).status, 200);
  const third = await add(3);
  assert.equal(third.status, 403, 'trial has 3 seats: owner + 2');
  assert.match(third.data.error, /الحد الأقصى/);
  assert.deepEqual((await acme('GET', '/api/users')).data.seats, { used: 3, total: 3 });
});

test('platform dashboard is for the platform owner only', async () => {
  assert.equal((await acme('GET', '/api/platform/overview')).status, 403);
  const o = await platform('GET', '/api/platform/overview');
  assert.equal(o.status, 200);
  assert.equal(o.data.totals.companies, 2);
  assert.equal(o.data.totals.trial, 1);
  assert.equal(o.data.totals.owned, 1);
  const row = o.data.companies.find((c) => c.id === acmeId);
  assert.equal(row.active_users, 3);
  assert.equal(row.owner.email, 'owner@acme.co');
});

test('reminders before expiry, then the company is locked until renewal', async () => {
  // Six days left → the "7 days" reminder, once.
  await db.run('UPDATE companies SET ends_at = ? WHERE id = ?', new Date(Date.now() + 6 * DAY).toISOString(), acmeId);
  assert.equal(await runSubscriptionReminders(db), 1);
  assert.equal(await runSubscriptionReminders(db), 0, 'each stage is sent once');
  let notes = (await acme('GET', '/api/notifications')).data.notifications;
  assert.ok(notes.some((n) => n.type === 'subscription' && n.message.includes('6 أيام')));

  // Expired: work is blocked, account and subscription pages stay open.
  await db.run('UPDATE companies SET ends_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), acmeId);
  assert.equal(await runSubscriptionReminders(db), 1);
  const blocked = await acme('GET', '/api/projects');
  assert.equal(blocked.status, 402);
  assert.equal(blocked.data.reason, 'expired');
  assert.equal((await acme('GET', '/api/me')).data.user.company.ok, false);
  const sub = await acme('GET', '/api/subscription');
  assert.equal(sub.status, 200);
  assert.equal(sub.data.company.reason, 'expired');
  assert.equal(sub.data.company.seats_used, 3);
  assert.equal((await acme('POST', '/api/subscription/renewal-request', { note: 'Please renew for 10 users' })).status, 200);
  notes = (await platform('GET', '/api/notifications')).data.notifications;
  assert.ok(notes.some((n) => n.message.includes('طلب تجديد') && n.message.includes('Acme')));
  assert.ok(notes.some((n) => n.message.includes('انتهى اشتراك شركة «Acme»')));

  // Renewal for a year with 10 seats restores access and clears the reminder record.
  const renew = await platform('POST', `/api/platform/companies/${acmeId}/subscription`, { action: 'renew', years: 1, seats: 10 });
  assert.equal(renew.status, 200, JSON.stringify(renew.data));
  assert.equal(renew.data.company.plan, 'annual');
  assert.equal(renew.data.company.seats, 10);
  assert.ok(renew.data.company.days_left >= 364);
  assert.equal((await acme('GET', '/api/projects')).status, 200);
  notes = (await acme('GET', '/api/notifications')).data.notifications;
  assert.ok(notes.some((n) => n.message.includes('تم تجديد اشتراك')));
  const detail = await platform('GET', `/api/platform/companies/${acmeId}`);
  assert.deepEqual(detail.data.events.slice(0, 2).map((e) => e.kind), ['renewed', 'renewal_request']);
});

test('suspension, ownership and seat changes', async () => {
  await platform('POST', `/api/platform/companies/${acmeId}/subscription`, { action: 'suspend', note: 'Unpaid' });
  const suspended = await acme('GET', '/api/projects');
  assert.equal(suspended.status, 402);
  assert.equal(suspended.data.reason, 'suspended');
  await platform('POST', `/api/platform/companies/${acmeId}/subscription`, { action: 'reactivate' });
  assert.equal((await acme('GET', '/api/projects')).status, 200);

  const tooFew = await platform('POST', `/api/platform/companies/${acmeId}/subscription`, { action: 'seats', seats: 2 });
  assert.equal(tooFew.status, 400);

  const owned = await platform('POST', `/api/platform/companies/${acmeId}/subscription`, { action: 'set_owned' });
  assert.equal(owned.data.company.plan, 'owned');
  assert.equal(owned.data.company.ends_at, null);
  assert.equal(owned.data.company.seats, null);
  assert.equal((await acme('GET', '/api/me')).data.user.company.days_left, null);
  assert.equal((await platform('POST', `/api/platform/companies/${acmeId}/remind`, {})).status, 400, 'owned needs no renewal');
});

test('platform creates companies and controls any account', async () => {
  const r = await platform('POST', '/api/platform/companies', {
    name: 'Beta', plan: 'annual', seats: 5, years: 2,
    owner_name: 'Beta Owner', owner_email: 'owner@beta.co', owner_password: 'secret123', owner_phone: '01022222222',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.company.days_left > 700);
  const beta = client();
  assert.equal((await beta('POST', '/api/login', { email: 'owner@beta.co', password: 'secret123' })).status, 200);

  const extendNonTrial = await platform('POST', `/api/platform/companies/${r.data.company.id}/subscription`, { action: 'extend_trial', days: 10 });
  assert.equal(extendNonTrial.status, 400);

  const ownerId = r.data.company.owner.id;
  assert.equal((await platform('PATCH', `/api/platform/users/${ownerId}`, { active: false })).status, 200);
  assert.equal((await beta('GET', '/api/me')).status, 401, 'suspended account is signed out');
  await platform('PATCH', `/api/platform/users/${ownerId}`, { active: true, password: 'reset789' });
  assert.equal((await client()('POST', '/api/login', { email: 'owner@beta.co', password: 'reset789' })).status, 200);
  assert.equal((await acme('PATCH', `/api/platform/users/${ownerId}`, { active: false })).status, 403);
});

test('older single-company databases are migrated into a company', async () => {
  const file = path.join(tmpDir, 'old.db');
  const old = await openDatabase(`file:${file}`);
  // Simulate pre-platform rows: users and a project without a company.
  await old.run("INSERT INTO users (name, email, password_hash, role, roles, created_at) VALUES ('Boss', 'b@old.co', 'x', 'owner', 'owner', '2026')");
  await old.run("INSERT INTO users (name, email, password_hash, role, roles, supervisor_id, created_at) VALUES ('Emp', 'e@old.co', 'x', 'employee', 'employee', 1, '2026')");
  await old.run("INSERT INTO projects (name, created_by, created_at) VALUES ('P', 1, '2026')");
  old.close();
  const migrated = await openDatabase(`file:${file}`);
  const company = await migrated.get('SELECT * FROM companies');
  assert.equal(company.name, 'ابتكار');
  assert.equal(company.plan, 'owned');
  assert.equal((await migrated.get('SELECT COUNT(*) AS n FROM users WHERE company_id = ?', company.id)).n, 2);
  assert.equal((await migrated.get("SELECT is_platform FROM users WHERE email = 'b@old.co'")).is_platform, 1);
  assert.equal((await migrated.get('SELECT company_id FROM projects')).company_id, company.id);
  migrated.close();
});
