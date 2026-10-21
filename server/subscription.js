'use strict';

// Company subscriptions: trial, annual (by number of accounts) and owned (perpetual licence).

const { HttpError } = require('./http');
const { now } = require('./db');
const { notify } = require('./access');

const DAY = 24 * 3600 * 1000;
const PLANS = ['trial', 'annual', 'owned'];
const PLAN_LABELS = { trial: 'فترة تجريبية', annual: 'اشتراك سنوي', owned: 'ملكية دائمة' };
// Renewal reminders go out this many days before the end date, then once on expiry.
const REMINDER_STAGES = [30, 14, 7, 3, 1];

function addYears(iso, years) {
  const d = new Date(iso);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString();
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * DAY).toISOString();
}

// Whether the company may work now; `company` may be a companies row or the company_* fields on a session user.
function accessOf(company, at = Date.now()) {
  const status = company.status ?? company.company_status;
  const plan = company.plan ?? company.company_plan;
  const endsAt = company.ends_at !== undefined ? company.ends_at : company.company_ends_at;
  if (!plan) return { ok: true, reason: null, days_left: null };
  if (status === 'suspended') return { ok: false, reason: 'suspended', days_left: null };
  if (plan === 'owned' || !endsAt) return { ok: true, reason: null, days_left: null };
  const ms = Date.parse(endsAt) - at;
  if (ms <= 0) return { ok: false, reason: 'expired', days_left: 0 };
  return { ok: true, reason: null, days_left: Math.ceil(ms / DAY) };
}

function accessError(reason) {
  const err = new HttpError(402, reason === 'suspended'
    ? 'تم إيقاف حساب شركتكم مؤقتًا؛ يُرجى التواصل مع إدارة منصة ابتكار'
    : 'انتهى اشتراك شركتكم؛ يُرجى تجديده لمواصلة العمل');
  err.reason = reason;
  return err;
}

async function activeSeats(db, companyId) {
  return (await db.get('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1', companyId)).n;
}

// Every active account takes one seat; a new or reactivated account needs a free one.
async function assertSeatAvailable(db, companyId) {
  const company = await db.get('SELECT seats FROM companies WHERE id = ?', companyId);
  if (company && company.seats !== null && (await activeSeats(db, companyId)) >= company.seats) {
    throw new HttpError(403, `وصلت شركتكم إلى الحد الأقصى من الحسابات في الباقة (${company.seats})؛ يُرجى ترقية الاشتراك أو إيقاف حساب غير مستخدم`);
  }
}

async function logEvent(db, companyId, kind, details = '', userId = null) {
  await db.run('INSERT INTO subscription_events (company_id, kind, details, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
    companyId, kind, details, userId, now());
}

async function createCompany(db, { name, plan, seats = null, days = 30, years = 1, userId = null }) {
  const ts = now();
  const endsAt = plan === 'owned' ? null : plan === 'trial' ? addDays(ts, days) : addYears(ts, years);
  const r = await db.run(`INSERT INTO companies (name, plan, seats, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    name, plan, seats, ts, endsAt, ts);
  const id = r.lastInsertRowid;
  await logEvent(db, id, 'created', `${PLAN_LABELS[plan]}${endsAt ? ` حتى ${endsAt.slice(0, 10)}` : ''}${seats ? ` — ${seats} حسابات` : ' — حسابات غير محدودة'}`, userId);
  return id;
}

// The company's owner(s) and system admins: the people responsible for renewing.
async function companyAdmins(db, companyId) {
  return db.all(`SELECT * FROM users WHERE company_id = ? AND active = 1
    AND (role = 'owner' OR ',' || roles || ',' LIKE '%,admin,%' OR ',' || roles || ',' LIKE '%,owner,%')`, companyId);
}

async function platformAdmins(db) {
  return db.all('SELECT * FROM users WHERE is_platform = 1 AND active = 1');
}

function dateAr(iso) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { dateStyle: 'long' }).format(new Date(iso));
}

// Sends each reminder stage once per subscription period (renewing clears the record).
async function runSubscriptionReminders(db, at = new Date(), messenger = null) {
  const companies = await db.all(`SELECT * FROM companies WHERE status = 'active' AND plan != 'owned' AND ends_at IS NOT NULL
    AND ends_at <= ?`, addDays(at.toISOString(), REMINDER_STAGES[0]));
  let sent = 0;
  for (const c of companies) {
    const daysLeft = Math.ceil((Date.parse(c.ends_at) - at.getTime()) / DAY);
    const done = new Set(c.reminded_stages.split(',').filter(Boolean));
    let stage = null;
    if (daysLeft <= 0) stage = 'expired';
    else stage = String(Math.min(...REMINDER_STAGES.filter((s) => daysLeft <= s)));
    if (done.has(stage)) continue;

    const what = c.plan === 'trial' ? 'الفترة التجريبية' : 'اشتراك شركتكم';
    const message = stage === 'expired'
      ? `⛔ انتهت ${what} في منصة ابتكار بتاريخ ${dateAr(c.ends_at)}؛ يُرجى التجديد لمواصلة العمل.`
      : `⏳ تنتهي ${what} في منصة ابتكار بعد ${daysLeft} ${daysLeft === 1 ? 'يوم' : daysLeft === 2 ? 'يومين' : daysLeft <= 10 ? 'أيام' : 'يومًا'} (${dateAr(c.ends_at)})؛ يُرجى التجديد لتجنّب توقف الخدمة.`;
    for (const admin of await companyAdmins(db, c.id)) {
      await notify(db, admin.id, 'subscription', message, '#/subscription');
      if (messenger && messenger.channels.email && messenger.sendNotice) {
        await messenger.sendNotice({ email: admin.email, name: admin.name, subject: 'تذكير بتجديد الاشتراك — منصة ابتكار', text: message })
          .catch((err) => console.error('renewal email failed:', err.message));
      }
    }
    if (stage === 'expired' || stage === '7') {
      for (const p of await platformAdmins(db)) {
        await notify(db, p.id, 'platform', stage === 'expired'
          ? `انتهى اشتراك شركة «${c.name}»` : `ينتهي اشتراك شركة «${c.name}» خلال ${daysLeft} أيام`, `#/platform/companies/${c.id}`);
      }
    }
    // A later stage implies the earlier ones are no longer worth sending.
    for (const s of REMINDER_STAGES) if (stage === 'expired' || s >= Number(stage)) done.add(String(s));
    done.add(stage);
    await db.run('UPDATE companies SET reminded_stages = ? WHERE id = ?', [...done].join(','), c.id);
    await logEvent(db, c.id, 'reminder', stage === 'expired' ? 'إشعار بانتهاء الاشتراك' : `تذكير قبل الانتهاء بـ ${daysLeft} يومًا`);
    sent++;
  }
  return sent;
}

module.exports = {
  DAY, PLANS, PLAN_LABELS, REMINDER_STAGES, addYears, addDays, accessOf, accessError, activeSeats,
  assertSeatAvailable, logEvent, createCompany, companyAdmins, platformAdmins, runSubscriptionReminders,
};
