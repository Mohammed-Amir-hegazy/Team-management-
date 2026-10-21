'use strict';

// "Forgot password": a 6-digit code sent by email, SMS or WhatsApp, then a new password.

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const auth = require('../auth');
const { publicUser } = require('../access');
const { normalizePhone } = require('../phone');

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_PER_HOUR = 5;
const GENERIC_SENT = 'إذا كانت البيانات مسجلة لدينا فسيصلك رمز التحقق خلال لحظات.';
const BAD_CODE = 'رمز التحقق غير صحيح أو انتهت صلاحيته';

function hashCode(userId, code) {
  return crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

// Users identify themselves by email or by their registered phone number.
async function findUser(db, identifier, countryCode) {
  const id = String(identifier || '').trim();
  if (!id) throw new HttpError(400, 'يُرجى إدخال البريد الإلكتروني أو رقم الهاتف');
  if (id.includes('@')) return db.get('SELECT * FROM users WHERE email = ? AND active = 1', id.toLowerCase());
  let phone;
  try { phone = normalizePhone(id, countryCode); } catch { return null; }
  return db.get('SELECT * FROM users WHERE phone = ? AND active = 1', phone);
}

module.exports = function register(router) {
  router.post('/api/password/forgot', async ({ db, body, config, messenger }) => {
    const channel = v.oneOf(body.channel, ['email', 'sms', 'whatsapp'], 'طريقة الإرسال');
    if (!messenger.channels[channel]) throw new HttpError(400, 'طريقة الإرسال المختارة غير مفعّلة حاليًا');
    const user = await findUser(db, body.identifier, config.defaultCountryCode);
    if (!user || (channel !== 'email' && !user.phone)) return { ok: true, message: GENERIC_SENT };

    const ts = new Date();
    const row = await db.get('SELECT * FROM password_resets WHERE user_id = ?', user.id);
    let windowStart = ts.toISOString();
    let windowCount = 1;
    if (row) {
      const since = (ts - new Date(row.sent_at)) / 1000;
      if (since < RESEND_SECONDS) {
        throw new HttpError(429, `يُرجى الانتظار ${Math.ceil(RESEND_SECONDS - since)} ثانية قبل طلب رمز جديد`);
      }
      if (ts - new Date(row.window_start) < 3600 * 1000) {
        if (row.window_count >= MAX_PER_HOUR) throw new HttpError(429, 'تجاوزت عدد الطلبات المسموح به خلال ساعة؛ يُرجى المحاولة لاحقًا');
        windowStart = row.window_start;
        windowCount = row.window_count + 1;
      }
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expires = new Date(ts.getTime() + CODE_MINUTES * 60 * 1000).toISOString();
    await db.run(`
      INSERT INTO password_resets (user_id, code_hash, expires_at, attempts, sent_at, window_start, window_count)
      VALUES (?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
        attempts = 0, sent_at = excluded.sent_at, window_start = excluded.window_start, window_count = excluded.window_count
    `, user.id, hashCode(user.id, code), expires, ts.toISOString(), windowStart, windowCount);

    await messenger.sendCode(channel, { email: user.email, phone: user.phone, name: user.name, code, minutes: CODE_MINUTES });
    return { ok: true, message: GENERIC_SENT };
  }, { public: true });

  // A correct code sets the new password, signs out every other device and signs this one in.
  router.post('/api/password/reset', async ({ db, body, res, config }) => {
    const code = String(body.code || '').replace(/\D/g, '');
    const password = auth.validatePassword(body.new_password);
    const user = await findUser(db, body.identifier, config.defaultCountryCode);
    const row = user && await db.get('SELECT * FROM password_resets WHERE user_id = ?', user.id);
    if (!row) throw new HttpError(400, BAD_CODE);
    if (row.expires_at < now() || row.attempts >= MAX_ATTEMPTS) {
      await db.run('DELETE FROM password_resets WHERE user_id = ?', user.id);
      throw new HttpError(400, row.attempts >= MAX_ATTEMPTS
        ? 'تجاوزت عدد المحاولات المسموح به؛ يُرجى طلب رمز جديد' : BAD_CODE);
    }
    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hashCode(user.id, code), 'hex');
    if (code.length !== 6 || !crypto.timingSafeEqual(expected, actual)) {
      await db.run('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?', user.id);
      const left = MAX_ATTEMPTS - row.attempts - 1;
      throw new HttpError(400, left > 0 ? `${BAD_CODE}؛ المحاولات المتبقية: ${left}` : 'تجاوزت عدد المحاولات المسموح به؛ يُرجى طلب رمز جديد');
    }

    await db.transaction(async (tx) => {
      await tx.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), user.id);
      await tx.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      await tx.run('DELETE FROM password_resets WHERE user_id = ?', user.id);
    });
    res.setHeader('Set-Cookie', auth.sessionCookie(await auth.createSession(db, user.id)));
    return { user: publicUser(user) };
  }, { public: true });
};
