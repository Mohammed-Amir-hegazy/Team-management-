'use strict';

// Push notifications to people's devices: Web Push for browsers and the installed web app (keys made
// once and kept in the database, so nothing needs configuring), and Firebase Cloud Messaging for the
// Android app when FIREBASE_SERVICE_ACCOUNT is set.
//
// Notifications made while answering a request are sent after the request succeeds (see app.js), so a
// failed action never pings anyone; others (the scheduler's alarms) are sent straight away.

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const webpush = require('web-push');
const { now } = require('./db');

const requestScope = new AsyncLocalStorage();
let state = null; // { db, vapid, fcm }

async function setting(db, key, make) {
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', key);
  if (row) return row.value;
  await db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', key, make());
  return (await db.get('SELECT value FROM app_settings WHERE key = ?', key)).value;
}

// Firebase service account JSON (as is, or base64), for the Android app's notifications.
function fcmFromEnv(env) {
  const raw = (env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (json.client_email && json.private_key && json.project_id) return { ...json, token: null, expires: 0 };
  } catch { /* reported below */ }
  console.error('FIREBASE_SERVICE_ACCOUNT is not a valid service account JSON; Android notifications are off.');
  return null;
}

async function initPush(db, env = process.env) {
  const pair = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    : JSON.parse(await setting(db, 'vapid', () => JSON.stringify(webpush.generateVAPIDKeys())));
  state = { db, vapid: { ...pair, subject: `mailto:${env.PUSH_CONTACT_EMAIL || 'support@ebtikar.dev'}` }, fcm: fcmFromEnv(env) };
  return { webPublicKey: pair.publicKey, native: !!state.fcm };
}

function pushInfo() {
  return state ? { web: state.vapid.publicKey, native: !!state.fcm } : { web: null, native: false };
}

// --- Firebase Cloud Messaging (HTTP v1, service-account OAuth token) -------------------------------

async function fcmAccessToken(fetchImpl) {
  const f = state.fcm;
  if (f.token && f.expires > Date.now() + 60000) return f.token;
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: f.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(f.private_key).toString('base64url');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
  });
  if (!res.ok) throw new Error(`FCM auth ${res.status}`);
  const data = await res.json();
  f.token = data.access_token;
  f.expires = Date.now() + (data.expires_in || 3600) * 1000;
  return f.token;
}

async function sendFcm(db, row, payload, fetchImpl = globalThis.fetch) {
  const token = await fcmAccessToken(fetchImpl);
  const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${state.fcm.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: row.token,
        notification: { title: payload.title, body: payload.body },
        data: { link: payload.link || '' },
        android: { priority: 'high', notification: { channel_id: 'alerts', sound: 'default' } },
      },
    }),
  });
  // An app that was uninstalled or logged out: forget its token.
  if (res.status === 404 || res.status === 400) await db.run('DELETE FROM device_tokens WHERE id = ?', row.id);
  else if (!res.ok) throw new Error(`FCM ${res.status}`);
}

// --- Sending -------------------------------------------------------------------------------------------

async function sendToUser(userId, payload) {
  if (!state) return;
  const { db } = state;
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  const tokens = state.fcm ? await db.all('SELECT * FROM device_tokens WHERE user_id = ?', userId) : [];
  const body = JSON.stringify(payload);
  await Promise.allSettled([
    ...subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          TTL: 24 * 3600, urgency: 'high', vapidDetails: state.vapid,
        });
      } catch (err) {
        // The browser dropped this subscription (cleared data, uninstalled): stop sending to it.
        if (err.statusCode === 404 || err.statusCode === 410) await db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
        else console.error('web push:', err.statusCode || err.message);
      }
    }),
    ...tokens.map((t) => sendFcm(db, t, payload).catch((err) => console.error('fcm push:', err.message))),
  ]);
}

// Called for every in-app notification.
function queuePush(userId, message, link = '') {
  if (!state) return;
  const payload = { title: 'ابتكار', body: message, link };
  const scope = requestScope.getStore();
  if (scope) scope.push({ userId, payload });
  else sendToUser(userId, payload).catch((err) => console.error('push:', err.message));
}

// Runs a request; its notifications are pushed once it has succeeded (bounded, so a slow push service
// never holds the answer back for long).
async function withPushScope(fn) {
  const pending = [];
  const result = await requestScope.run(pending, fn);
  if (pending.length) {
    await Promise.race([
      Promise.allSettled(pending.map((p) => sendToUser(p.userId, p.payload))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  }
  return result;
}

async function saveSubscription(db, userId, sub) {
  const endpoint = String(sub && sub.endpoint || '');
  const keys = (sub && sub.keys) || {};
  if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) throw Object.assign(new Error('bad subscription'), { bad: true });
  await db.run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  userId, endpoint, String(keys.p256dh), String(keys.auth), now());
}

async function saveDeviceToken(db, userId, token, platform) {
  await db.run(`INSERT INTO device_tokens (user_id, token, platform, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id`, userId, token, platform, now());
}

module.exports = {
  initPush, pushInfo, queuePush, withPushScope, sendToUser, saveSubscription, saveDeviceToken,
};
