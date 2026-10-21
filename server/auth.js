'use strict';

const crypto = require('node:crypto');
const { now } = require('./db');
const { HttpError } = require('./http');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw new HttpError(400, 'يجب ألا تقل كلمة المرور عن ستة أحرف');
  }
  return password;
}

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  return token;
}

function sessionCookie(token) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  const maxAge = token ? SESSION_DAYS * 24 * 3600 : 0;
  return `sid=${token || ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function userFromSession(db, token) {
  if (!token) return null;
  // The company's subscription fields ride along so the access check needs no extra query.
  const row = await db.get(`
    SELECT u.*, c.name AS company_name, c.plan AS company_plan, c.status AS company_status,
           c.ends_at AS company_ends_at, c.starts_at AS company_starts_at, c.seats AS company_seats
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN companies c ON c.id = u.company_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
  `, token, now());
  return row || null;
}

async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', token);
}

module.exports = { hashPassword, verifyPassword, validatePassword, createSession, sessionCookie, userFromSession, destroySession };
