'use strict';

// The platform owner's dashboard: every company, its subscription and its people.

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const auth = require('../auth');
const { getUser, publicUser, notify } = require('../access');
const { normalizePhone } = require('../phone');
const {
  PLANS, PLAN_LABELS, addYears, addDays, accessOf, activeSeats, logEvent, createCompany, companyAdmins,
} = require('../subscription');

function requirePlatform(user) {
  if (!user.is_platform) throw new HttpError(403, 'هذه الصفحة متاحة لإدارة منصة ابتكار فقط');
}

const COMPANY_SQL = `
  SELECT c.*,
    (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS active_users,
    (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS total_users,
    (SELECT MAX(u.last_login_at) FROM users u WHERE u.company_id = c.id) AS last_activity,
    (SELECT u.id FROM users u WHERE u.company_id = c.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_id
  FROM companies c
`;

async function withOwner(db, c) {
  const owner = c.owner_id ? await getUser(db, c.owner_id) : null;
  return {
    ...c,
    plan_label: PLAN_LABELS[c.plan],
    ...accessOf(c),
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone } : null,
  };
}

function optionalSeats(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 0 || value === '0') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100000) throw new HttpError(400, 'عدد الحسابات غير صحيح');
  return n;
}

function boundedInt(value, label, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `قيمة «${label}» غير صحيحة`);
  return n;
}

async function loadCompany(db, id) {
  const company = await db.get(`${COMPANY_SQL} WHERE c.id = ?`, id);
  if (!company) throw new HttpError(404, 'الشركة غير موجودة');
  return company;
}

module.exports = function register(router) {
  router.get('/api/platform/overview', async ({ db, user }) => {
    requirePlatform(user);
    const companies = await Promise.all((await db.all(`${COMPANY_SQL} ORDER BY c.created_at DESC`)).map((c) => withOwner(db, c)));
    const count = (fn) => companies.filter(fn).length;
    return {
      companies,
      totals: {
        companies: companies.length,
        trial: count((c) => c.plan === 'trial' && c.ok),
        annual: count((c) => c.plan === 'annual' && c.ok),
        owned: count((c) => c.plan === 'owned'),
        expiring: count((c) => c.ok && c.days_left !== null && c.days_left <= 30),
        expired: count((c) => c.reason === 'expired'),
        suspended: count((c) => c.reason === 'suspended'),
        users: companies.reduce((n, c) => n + c.active_users, 0),
        seats_sold: companies.filter((c) => c.plan === 'annual' && c.seats).reduce((n, c) => n + c.seats, 0),
      },
    };
  }, { ungated: true });

  // A company created by the platform owner, with its first account (the company owner).
  router.post('/api/platform/companies', async ({ db, user, body, config }) => {
    requirePlatform(user);
    const name = v.text(body.name, 'اسم الشركة', { max: 160 });
    const plan = v.oneOf(body.plan, PLANS, 'نوع الاشتراك');
    const seats = optionalSeats(body.seats) ?? (plan === 'trial' ? config.trialSeats : null);
    const ownerName = v.text(body.owner_name, 'اسم مالك الشركة', { max: 120 });
    const email = v.text(body.owner_email, 'البريد الإلكتروني', { max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'صيغة البريد الإلكتروني غير صحيحة');
    const password = auth.validatePassword(body.owner_password);
    const phone = normalizePhone(body.owner_phone, config.defaultCountryCode);
    if (await db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
    if (phone && await db.get('SELECT 1 FROM users WHERE phone = ?', phone)) throw new HttpError(409, 'رقم الهاتف مسجّل في حساب آخر');
    const years = boundedInt(body.years, 'عدد السنوات', 1, 10, 1);
    const days = boundedInt(body.days, 'عدد الأيام', 1, 365, config.trialDays);

    const id = await db.transaction(async (tx) => {
      const companyId = await createCompany(tx, { name, plan, seats, days, years, userId: user.id });
      await tx.run(`
        INSERT INTO users (name, email, password_hash, role, roles, job_title, phone, company_id, supervisor_id, created_at)
        VALUES (?, ?, ?, 'owner', 'owner', ?, ?, ?, NULL, ?)
      `, ownerName, email, auth.hashPassword(password), v.text(body.owner_job_title, 'المسمى الوظيفي', { required: false, max: 120 }),
      phone, companyId, now());
      return companyId;
    });
    return { company: await withOwner(db, await loadCompany(db, id)) };
  }, { ungated: true });

  router.get('/api/platform/companies/:id', async ({ db, user, params }) => {
    requirePlatform(user);
    const company = await withOwner(db, await loadCompany(db, v.id(params.id, 'الشركة')));
    const users = (await db.all(`SELECT u.*, s.name AS supervisor_name FROM users u LEFT JOIN users s ON s.id = u.supervisor_id
      WHERE u.company_id = ? ORDER BY u.active DESC, u.name`, company.id))
      .map((u) => ({ ...publicUser(u), supervisor_name: u.supervisor_name, last_login_at: u.last_login_at }));
    const events = await db.all(`SELECT e.*, u.name AS user_name FROM subscription_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.company_id = ? ORDER BY e.id DESC LIMIT 100`, company.id);
    const stats = await db.get(`SELECT
        (SELECT COUNT(*) FROM projects WHERE company_id = ? AND personal_owner_id IS NULL) AS projects,
        (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.company_id = ?) AS tasks,
        (SELECT COUNT(*) FROM reports r JOIN users s ON s.id = r.sender_id WHERE s.company_id = ?) AS reports`,
    company.id, company.id, company.id);
    return { company, users, events, stats };
  }, { ungated: true });

  router.patch('/api/platform/companies/:id', async ({ db, user, params, body }) => {
    requirePlatform(user);
    const company = await loadCompany(db, v.id(params.id, 'الشركة'));
    const name = body.name !== undefined ? v.text(body.name, 'اسم الشركة', { max: 160 }) : company.name;
    const notes = body.notes !== undefined ? v.text(body.notes, 'الملاحظات', { required: false, max: 5000 }) : company.notes;
    await db.run('UPDATE companies SET name = ?, notes = ? WHERE id = ?', name, notes, company.id);
    if (name !== company.name) await logEvent(db, company.id, 'edited', `تغيير الاسم من «${company.name}» إلى «${name}»`, user.id);
    return { company: await withOwner(db, await loadCompany(db, company.id)) };
  }, { ungated: true });

  // renew | extend_trial | set_owned | seats | suspend | reactivate
  router.post('/api/platform/companies/:id/subscription', async ({ db, user, params, body }) => {
    requirePlatform(user);
    const c = await loadCompany(db, v.id(params.id, 'الشركة'));
    const action = v.oneOf(body.action, ['renew', 'extend_trial', 'set_owned', 'seats', 'suspend', 'reactivate'], 'الإجراء');
    const seats = optionalSeats(body.seats);
    if (seats !== undefined && seats !== null && seats < c.active_users) {
      throw new HttpError(400, `لدى الشركة ${c.active_users} حسابات نشطة، وهو أكثر من العدد المطلوب؛ يجب إيقاف بعض الحسابات أولًا`);
    }
    const ts = now();
    const base = c.ends_at && c.ends_at > ts ? c.ends_at : ts;
    const longDate = (iso) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { dateStyle: 'long' }).format(new Date(iso));
    let changes; let event; let notice = null;
    if (action === 'renew') {
      const years = boundedInt(body.years, 'عدد السنوات', 1, 10, 1);
      const endsAt = addYears(base, years);
      changes = { plan: 'annual', ends_at: endsAt, reminded_stages: '', seats: seats === undefined ? c.seats : seats };
      if (c.plan !== 'annual') changes.starts_at = ts;
      event = ['renewed', `تجديد ${years === 1 ? 'سنة واحدة' : `${years} سنوات`} حتى ${endsAt.slice(0, 10)}`];
      notice = `✅ تم تجديد اشتراك شركتكم في منصة ابتكار حتى ${longDate(endsAt)}.`;
    } else if (action === 'extend_trial') {
      if (c.plan !== 'trial') throw new HttpError(400, 'هذه الشركة ليست في فترة تجريبية');
      const days = boundedInt(body.days, 'عدد الأيام', 1, 365, 14);
      const endsAt = addDays(base, days);
      changes = { ends_at: endsAt, reminded_stages: '' };
      event = ['trial_extended', `تمديد الفترة التجريبية ${days} يومًا حتى ${endsAt.slice(0, 10)}`];
      notice = `تم تمديد الفترة التجريبية لشركتكم في منصة ابتكار حتى ${longDate(endsAt)}.`;
    } else if (action === 'set_owned') {
      changes = { plan: 'owned', ends_at: null, reminded_stages: '', seats: seats === undefined ? null : seats };
      event = ['owned', `تحويل إلى ملكية دائمة${changes.seats ? ` — ${changes.seats} حسابات` : ' — حسابات غير محدودة'}`];
      notice = '🎉 أصبحت شركتكم تمتلك منصة ابتكار ملكية دائمة دون الحاجة إلى تجديد.';
    } else if (action === 'seats') {
      if (seats === undefined) throw new HttpError(400, 'يُرجى تحديد عدد الحسابات');
      changes = { seats };
      event = ['seats', seats ? `تعديل الحد الأقصى للحسابات إلى ${seats}` : 'حسابات غير محدودة'];
      notice = seats ? `تم تعديل الحد الأقصى لحسابات شركتكم إلى ${seats} حسابات.` : 'أصبح عدد حسابات شركتكم غير محدود.';
    } else if (action === 'suspend') {
      changes = { status: 'suspended' };
      event = ['suspended', v.text(body.note, 'السبب', { required: false, max: 500 })];
    } else {
      changes = { status: 'active' };
      event = ['reactivated', ''];
      notice = 'تمت إعادة تفعيل حساب شركتكم في منصة ابتكار.';
    }

    const columns = Object.keys(changes);
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE companies SET ${columns.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        ...columns.map((k) => changes[k]), c.id);
      await logEvent(tx, c.id, event[0], event[1], user.id);
      if (notice) for (const a of await companyAdmins(tx, c.id)) await notify(tx, a.id, 'subscription', notice, '#/subscription');
    });
    return { company: await withOwner(db, await loadCompany(db, c.id)) };
  }, { ungated: true });

  // Reminds the company's owner and system admins in the app; the page also offers WhatsApp.
  router.post('/api/platform/companies/:id/remind', async ({ db, user, params }) => {
    requirePlatform(user);
    const c = await withOwner(db, await loadCompany(db, v.id(params.id, 'الشركة')));
    if (c.plan === 'owned') throw new HttpError(400, 'هذه الشركة تمتلك المنصة ملكية دائمة ولا تحتاج إلى تجديد');
    const message = c.ok
      ? `⏳ تذكير من إدارة منصة ابتكار: متبقٍ ${c.days_left} يومًا على انتهاء ${c.plan === 'trial' ? 'الفترة التجريبية' : 'اشتراك شركتكم'}؛ يُرجى التجديد لتجنّب توقف الخدمة.`
      : '⛔ تذكير من إدارة منصة ابتكار: انتهى اشتراك شركتكم؛ يُرجى التجديد لمواصلة العمل.';
    const admins = await companyAdmins(db, c.id);
    for (const a of admins) await notify(db, a.id, 'subscription', message, '#/subscription');
    await logEvent(db, c.id, 'reminder', 'تذكير يدوي من إدارة المنصة', user.id);
    return { ok: true, notified: admins.length };
  }, { ungated: true });

  // Platform-level control of any account: suspend/reactivate and password reset.
  router.patch('/api/platform/users/:id', async ({ db, user, params, body }) => {
    requirePlatform(user);
    const target = await getUser(db, v.id(params.id, 'المستخدم'));
    if (!target) throw new HttpError(404, 'المستخدم غير موجود');
    if (body.active !== undefined) {
      if (target.id === user.id && !body.active) throw new HttpError(400, 'لا يمكنك إيقاف حسابك');
      await db.run('UPDATE users SET active = ? WHERE id = ?', body.active ? 1 : 0, target.id);
      if (!body.active) await db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
      await logEvent(db, target.company_id, body.active ? 'user_activated' : 'user_suspended', target.name, user.id);
    }
    if (body.password) {
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(auth.validatePassword(body.password)), target.id);
      if (target.id !== user.id) await db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
      await logEvent(db, target.company_id, 'password_reset', target.name, user.id);
    }
    return { user: publicUser(await getUser(db, target.id)), seats_used: await activeSeats(db, target.company_id) };
  }, { ungated: true });
};
