'use strict';

// Where data is stored, the warnings about storage that would be lost, and the one-time import.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { databaseSettings, storageWarning } = require('../server/storage');
const { importDatabase } = require('../server/importer');

let tmpDir;
test.before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-storage-')); });
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('a database chosen in EBTIKAR_DB_URL wins over the Turso integration', () => {
  const both = { EBTIKAR_DB_URL: 'libsql://main-org.turso.io', EBTIKAR_DB_TOKEN: 'mine', TURSO_DATABASE_URL: 'libsql://dpl-abc-org.turso.io', TURSO_AUTH_TOKEN: 'theirs' };
  assert.deepEqual(databaseSettings(both), { url: 'libsql://main-org.turso.io', authToken: 'mine', source: 'app' });
  assert.equal(storageWarning(both), null);
  // The integration's token works for databases in the same group.
  assert.equal(databaseSettings({ EBTIKAR_DB_URL: 'libsql://main-org.turso.io', TURSO_AUTH_TOKEN: 'group' }).authToken, 'group');

  assert.equal(storageWarning({ TURSO_DATABASE_URL: 'libsql://dpl-28436t72uabfyavktxylay-org.turso.io', VERCEL: '1' }), 'branch');
  assert.equal(storageWarning({ TURSO_DATABASE_URL: 'libsql://database-fulvous-flame-org.turso.io', VERCEL: '1' }), null);
  assert.equal(storageWarning({ VERCEL: '1' }), 'ephemeral');
  assert.equal(storageWarning({ RENDER: 'true' }), 'ephemeral');
  assert.equal(storageWarning({}), null, 'a local file on your own machine is fine');
});

function client(base) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

async function serve(db) {
  const config = { cloudinary: null, defaultCountryCode: '20', allowSignup: true, trialDays: 30, trialSeats: 10, platformOwnerEmail: 'boss@ebtikar.co' };
  const messenger = { channels: { email: false, sms: false, whatsapp: false }, async sendCode() {} };
  const server = http.createServer(createApp(db, { config, messenger }));
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function dump(db) {
  const out = {};
  for (const { name } of await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    out[name] = (await db.all(`SELECT * FROM ${name} ORDER BY rowid`)).map((r) => JSON.stringify(r, (k, v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString('hex') : v)));
  }
  return out;
}

test('all data is copied once from the old database into an empty one', async () => {
  const sourceUrl = `file:${path.join(tmpDir, 'branch.db')}`;
  const source = await openDatabase(sourceUrl);
  const app = await serve(source);
  const o = client(app.base);
  const me = (await o('POST', '/api/signup', { company_name: 'ابتكار', name: 'محمد', email: 'boss@ebtikar.co', password: 'secret123' })).data.user;
  const lead = (await o('POST', '/api/users', { name: 'قائد', email: 'l@e.co', password: 'secret123', roles: ['team_leader'], supervisor_id: me.id })).data.user;
  const emp = (await o('POST', '/api/users', { name: 'موظف', email: 'e@e.co', password: 'secret123', roles: ['employee'], supervisor_id: lead.id })).data.user;
  const p = (await o('POST', '/api/projects', { name: 'مشروع', member_ids: [lead.id] })).data.project;
  const t = (await o('POST', `/api/projects/${p.id}/tasks`, { title: 'مهمة', assignee_id: emp.id })).data.task;
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(500, 9)]);
  const up = (await o('POST', '/api/uploads/image', { purpose: 'task', task_id: t.id, data: `data:image/jpeg;base64,${jpeg.toString('base64')}` })).data;
  await o('POST', `/api/tasks/${t.id}/attachments`, { images: [up] });
  const e = client(app.base);
  await e('POST', '/api/login', { email: 'e@e.co', password: 'secret123' });
  await e('POST', `/api/tasks/${t.id}/status`, { status: 'blocked', note: 'سبب' });
  await e('POST', `/api/tasks/${t.id}/requirements`, { description: 'جهاز' });
  await e('POST', `/api/tasks/${t.id}/requirements/send`, {});
  await e('POST', '/api/reports', { title: 'تقرير', body: 'نص' });
  await client(app.base)('POST', '/api/signup', { company_name: 'النور', name: 'ليلى', email: 'l@nour.co', password: 'secret123' });
  app.server.close();
  // A supervisor added after their team (ids out of order) must not break the copy.
  await source.run("UPDATE users SET supervisor_id = (SELECT MAX(id) FROM users) WHERE email = 'boss@ebtikar.co'");
  const before = await dump(source);

  const target = await openDatabase(`file:${path.join(tmpDir, 'main.db')}`);
  const r = await importDatabase(target, { url: sourceUrl });
  assert.ok(r.copied, JSON.stringify(r));
  assert.equal(r.copied.users, 4);
  const after = await dump(target);
  for (const table of ['companies', 'users', 'projects', 'project_members', 'tasks', 'task_status_history', 'requests',
    'requirements', 'reports', 'attachments', 'images', 'notifications', 'subscription_events']) {
    assert.deepEqual(after[table], before[table], `${table} copied exactly`);
  }
  assert.deepEqual(await dump(source), before, 'the source is never changed');

  // The copy is a working platform: same logins, same photo.
  const copy = await serve(target);
  const again = client(copy.base);
  assert.equal((await again('POST', '/api/login', { email: 'e@e.co', password: 'secret123' })).status, 200);
  assert.equal((await again('GET', `/api/tasks/${t.id}`)).data.task.status, 'blocked');
  copy.server.close();

  // Running again (every start while IMPORT_FROM_URL is set) never duplicates or overwrites.
  assert.deepEqual(await importDatabase(target, { url: sourceUrl }), { skipped: 'target-not-empty' });
  assert.equal((await target.get('SELECT COUNT(*) AS n FROM users')).n, 4);
  source.close();
  target.close();
});

test('an empty source is skipped, and an older schema is brought up to date', async () => {
  const empty = await openDatabase(`file:${path.join(tmpDir, 'empty.db')}`);
  const target = await openDatabase(`file:${path.join(tmpDir, 't2.db')}`);
  assert.deepEqual(await importDatabase(target, { url: `file:${path.join(tmpDir, 'empty.db')}` }), { skipped: 'source-empty' });
  empty.close();

  // A database from the very first version: no companies, no roles, no phone numbers.
  const oldUrl = `file:${path.join(tmpDir, 'v1.db')}`;
  const old = createClient({ url: oldUrl });
  await old.executeMultiple(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, supervisor_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users VALUES (1, 'Boss', 'b@old.co', 'x', 'owner', NULL, 1, '2026'), (2, 'Emp', 'e@old.co', 'x', 'employee', 1, 1, '2026');
    INSERT INTO projects (id, name, created_by, created_at) VALUES (1, 'P', 1, '2026');`);
  old.close();
  const r = await importDatabase(target, { url: oldUrl });
  assert.deepEqual(r.copied, { users: 2, projects: 1 });
  const company = await target.get('SELECT * FROM companies');
  assert.equal(company.plan, 'owned');
  assert.equal((await target.get("SELECT roles, company_id FROM users WHERE email = 'e@old.co'")).company_id, company.id);
  assert.equal((await target.get('SELECT company_id FROM projects')).company_id, company.id);
  target.close();
});

test('each platform update is announced once to every company, with steps for its admins', async () => {
  const { deliverReleases, RELEASES } = require('../server/releases');
  const db = await openDatabase(`file:${path.join(tmpDir, 'releases.db')}`);
  const app = await serve(db);
  const o = client(app.base);
  const me = (await o('POST', '/api/signup', { company_name: 'R1', name: 'Owner', email: 'boss@ebtikar.co', password: 'secret123' })).data.user;
  const emp = (await o('POST', '/api/users', { name: 'Emp', email: 'e@r1.co', password: 'secret123', roles: ['employee'], supervisor_id: me.id, gender: 'male' })).data.user;
  const emails = [];
  const messenger = { async sendNotice(n) { emails.push(n); } };

  const [first, second] = await Promise.all([deliverReleases(db, messenger), deliverReleases(db, messenger)]);
  assert.equal(first.length + second.length, RELEASES.length, 'two servers starting together announce it once');
  assert.deepEqual(await deliverReleases(db, messenger), [], 'and never again');
  await new Promise((r) => setTimeout(r, 50));

  const notes = async (id) => (await db.all('SELECT type, message, link FROM notifications WHERE user_id = ? AND type LIKE ? ORDER BY id', id, 'update%'));
  const ownerNotes = await notes(me.id);
  assert.equal(ownerNotes.filter((n) => n.type === 'update').length, RELEASES.length);
  assert.ok(ownerNotes.some((n) => n.type === 'update_action' && n.link === '#/people?genders=1'), 'the owner is asked to set genders (theirs is missing)');
  const empNotes = await notes(emp.id);
  assert.equal(empNotes.filter((n) => n.type === 'update_action').length, 0, 'employees get the news, not the admin steps');
  assert.ok(emails.some((e) => e.email === 'boss@ebtikar.co' && e.text.includes('خطوات مطلوبة')), 'admins also get it by email');
  assert.ok(!emails.some((e) => e.email === 'e@r1.co'));

  // The "what's new" sheet: steps only for owners and admins.
  assert.ok((await o('GET', '/api/releases')).data.releases[0].actions.length > 0);
  const e = client(app.base);
  await e('POST', '/api/login', { email: 'e@r1.co', password: 'secret123' });
  assert.equal((await e('GET', '/api/releases')).data.releases[0].actions.length, 0);
  app.server.close();
  db.close();
});
