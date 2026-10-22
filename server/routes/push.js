'use strict';

const { HttpError } = require('../http');
const v = require('../validate');
const { saveSubscription, saveDeviceToken } = require('../push');

module.exports = function register(router) {
  // This browser / installed web app wants push notifications for the signed-in person.
  router.post('/api/push/subscribe', async ({ db, user, body }) => {
    try {
      await saveSubscription(db, user.id, body.subscription);
    } catch (err) {
      if (err.bad) throw new HttpError(400, 'تعذّر تفعيل الإشعارات على هذا الجهاز');
      throw err;
    }
    return { ok: true };
  }, { ungated: true });

  // On sign-out (or when turned off): this device stops receiving them.
  router.post('/api/push/unsubscribe', async ({ db, user, body }) => {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(body.endpoint || ''), user.id);
    if (body.token) await db.run('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', String(body.token), user.id);
    return { ok: true };
  }, { ungated: true });

  // The Android app registers its Firebase token.
  router.post('/api/push/device', async ({ db, user, body }) => {
    const token = v.text(body.token, 'رمز الجهاز', { max: 4096 });
    const platform = v.oneOf(body.platform || 'android', ['android', 'ios'], 'نوع الجهاز');
    await saveDeviceToken(db, user.id, token, platform);
    return { ok: true };
  }, { ungated: true });
};
