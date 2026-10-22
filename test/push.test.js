'use strict';

// Push notifications: devices register, notifications reach them after the action succeeds, and
// devices that are gone are forgotten. Firebase is replaced by a stand-in that records what it receives.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(JSON.stringify({
  project_id: 'ebtikar-test', client_email: 'push@ebtikar-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
})).toString('base64');

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://oauth2.googleapis.com/')) {
    const assertion = new URLSearchParams(init.body).get('assertion');
    assert.equal(assertion.split('.').length, 3, 'a signed JWT');
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  }
  if (String(url).startsWith('https://fcm.googleapis.com/')) {
    const msg = JSON.parse(init.body).message;
    sent.push(msg);
    return new Response('{}', { status: msg.token === 'gone-token' ? 404 : 200 });
  }
  return realFetch(url, init);
};

const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');

let server; let base; let db; let tmpDir;
test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-push-'));
  db = await openDatabase(`file:${path.join(tmpDir, 'test.db')}`);
  const config = { cloudinary: null, defaultCountryCode: '20', allowSignup: true, trialDays: 30, trialSeats: 10, platformOwnerEmail: 'x@x.x' };
  const messenger = { channels: { email: false, sms: false, whatsapp: false }, async sendCode() {} };
  server = http.createServer(createApp(db, { config, messenger }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await realFetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

test('devices get the notifications, after the action succeeds', async () => {
  const boss = client();
  const me = (await boss('POST', '/api/signup', { company_name: 'Push', name: 'Boss', email: 'b@push.co', password: 'secret123' })).data.user;
  const emp = (await boss('POST', '/api/users', { name: 'Emp', email: 'e@push.co', password: 'secret123', roles: ['employee'], supervisor_id: me.id })).data.user;
  const e = client(); await e('POST', '/api/login', { email: 'e@push.co', password: 'secret123' });

  const cfg = (await boss('GET', '/api/client-config')).data.push;
  assert.ok(cfg.web && cfg.web.length > 40, 'web push key made by the platform itself');
  assert.equal(cfg.native, true);
  assert.equal((await e('POST', '/api/push/subscribe', { subscription: { endpoint: 'javascript:x' } })).status, 400);
  assert.equal((await e('POST', '/api/push/device', { token: 'phone-1', platform: 'android' })).status, 200);

  await boss('POST', '/api/tasks', { title: 'Call the client', assignee_id: emp.id });
  assert.equal(sent.length, 1, 'pushed by the time the answer arrives');
  assert.equal(sent[0].token, 'phone-1');
  assert.match(sent[0].notification.body, /Call the client/);
  assert.match(sent[0].data.link, /^#\/tasks\/\d+$/);

  // A failed action pings nobody.
  await boss('POST', '/api/tasks', { title: '', assignee_id: emp.id });
  assert.equal(sent.length, 1);

  // A phone that is gone is forgotten; signing out removes this phone.
  await db.run("INSERT INTO device_tokens (user_id, token, platform, created_at) VALUES (?, 'gone-token', 'android', '2026')", emp.id);
  await boss('POST', '/api/tasks', { title: 'Second', assignee_id: emp.id });
  assert.equal(sent.length, 3);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM device_tokens WHERE token = 'gone-token'")).n, 0);
  await e('POST', '/api/push/unsubscribe', { token: 'phone-1' });
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM device_tokens')).n, 0);
});
