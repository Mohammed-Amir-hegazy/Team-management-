'use strict';

// The company side of the subscription: its owner and system admins see the plan, the time left,
// account usage and history, and can ask the platform for a renewal.

const { HttpError } = require('../http');
const v = require('../validate');
const { isAdmin, notify } = require('../access');
const {
  PLAN_LABELS, accessOf, activeSeats, logEvent, platformAdmins,
} = require('../subscription');

async function platformContact(db, config) {
  if (config.platformContact && config.platformContact.phone) return config.platformContact;
  const p = await db.get('SELECT phone, email, name FROM users WHERE is_platform = 1 AND active = 1 ORDER BY id LIMIT 1');
  return { phone: (p && p.phone) || '', email: (config.platformContact && config.platformContact.email) || (p && p.email) || '' };
}

module.exports = function register(router) {
  router.get('/api/subscription', async ({ db, user, config }) => {
    const company = await db.get('SELECT * FROM companies WHERE id = ?', user.company_id);
    if (!company) throw new HttpError(404, 'لا توجد بيانات اشتراك');
    const admin = isAdmin(user);
    const out = {
      company: {
        id: company.id, name: company.name, plan: company.plan, plan_label: PLAN_LABELS[company.plan],
        starts_at: company.starts_at, ends_at: company.ends_at, status: company.status, seats: company.seats,
        ...accessOf(company),
      },
      can_manage: admin,
      contact: await platformContact(db, config),
    };
    if (admin) {
      out.company.seats_used = await activeSeats(db, company.id);
      out.events = await db.all(`SELECT e.kind, e.details, e.created_at, u.name AS user_name FROM subscription_events e
        LEFT JOIN users u ON u.id = e.user_id WHERE e.company_id = ? ORDER BY e.id DESC LIMIT 20`, company.id);
    }
    return out;
  }, { ungated: true });

  router.post('/api/subscription/renewal-request', async ({ db, user, body }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'طلب التجديد متاح لصاحب الشركة ومسؤول النظام');
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 1000 });
    const recent = await db.get(`SELECT 1 FROM subscription_events WHERE company_id = ? AND kind = 'renewal_request' AND created_at > ?`,
      user.company_id, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if (recent) throw new HttpError(429, 'أُرسل طلب تجديد قبل قليل، وسيتواصل معكم فريق ابتكار قريبًا');
    const company = await db.get('SELECT name FROM companies WHERE id = ?', user.company_id);
    await logEvent(db, user.company_id, 'renewal_request', note, user.id);
    for (const p of await platformAdmins(db)) {
      await notify(db, p.id, 'platform', `طلب تجديد من شركة «${company.name}» (${user.name})${note ? `: ${note}` : ''}`,
        `#/platform/companies/${user.company_id}`);
    }
    return { ok: true };
  }, { ungated: true });
};
