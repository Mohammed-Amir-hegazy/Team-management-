'use strict';

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const auth = require('../auth');
const {
  ROLES, roleRank, userRoles, isAdmin, primaryRole, getUser, subordinateIds, ancestorIds, publicUser, notify,
} = require('../access');
const { normalizePhone, maskPhone } = require('../phone');
const { assertDeletable, deleteAccount, deleteCompany, liveCompanyUsers } = require('../accounts');
const { isPlatformEmail } = require('../owner');
const { brandOf } = require('../brand');
const { decodeImage } = require('../images');
const crypto = require('node:crypto');
const {
  accessOf, activeSeats, assertSeatAvailable, createCompany, platformAdmins, PLAN_LABELS,
} = require('../subscription');

const NOT_ALLOWED = 'ليست لديك صلاحية لتنفيذ هذا الإجراء';

const { validatePassword } = auth;

function validateEmail(value) {
  const email = v.text(value, 'البريد الإلكتروني', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'صيغة البريد الإلكتروني غير صحيحة');
  return email;
}

// Roles chosen by an admin: any mix except "owner", with at least one organisational level.
function validateRoles(value) {
  if (!Array.isArray(value)) throw new HttpError(400, 'يجب اختيار دور واحد على الأقل');
  const roles = [...new Set(value)];
  for (const r of roles) {
    if (!ROLES.includes(r) || r === 'owner') throw new HttpError(400, 'أحد الأدوار المختارة غير صالح');
  }
  if (!primaryRole(roles)) throw new HttpError(400, 'يجب اختيار مستوى وظيفي واحد على الأقل (مدير أو قائد فريق أو موظف)');
  return roles;
}

// Phone numbers identify people for password recovery, so each one belongs to one account.
async function readPhone(db, value, config, exceptId = 0) {
  const phone = normalizePhone(value, config.defaultCountryCode);
  if (phone && await db.get('SELECT 1 FROM users WHERE phone = ? AND id != ?', phone, exceptId)) {
    throw new HttpError(409, 'رقم الهاتف مسجّل في حساب آخر');
  }
  return phone;
}

async function emailTaken(db, email, exceptId = 0) {
  return !!(await db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', email, exceptId));
}

async function companyHasOwner(db, companyId) {
  return !!(await db.get("SELECT 1 FROM users WHERE company_id = ? AND role = 'owner' AND active = 1 AND deleted_at IS NULL", companyId));
}

// The direct supervisor chosen in the form. Until a company has its owner (it was registered by its system
// admin), people may sit at the top without one; they move under the owner as soon as it is added.
async function readSupervisor(db, value, companyId) {
  if (value === null || value === undefined || value === '' || value === 0) {
    if (await companyHasOwner(db, companyId)) throw new HttpError(400, 'يُرجى اختيار المسؤول المباشر');
    return null;
  }
  return v.id(value, 'المسؤول المباشر');
}

// A supervisor must sit at a higher level, and nobody may end up supervising themselves.
async function checkPlacement(db, { userId = null, level, supervisorId, companyId }) {
  if (supervisorId) {
    const supervisor = await getUser(db, supervisorId);
    if (!supervisor || !supervisor.active || supervisor.company_id !== companyId) {
      throw new HttpError(400, 'المسؤول المباشر المحدد غير موجود');
    }
    if (roleRank(supervisor.role) >= roleRank(level)) {
      throw new HttpError(400, 'يجب أن يكون المسؤول المباشر في مستوى وظيفي أعلى');
    }
  }
  if (userId) {
    if (supervisorId && (supervisorId === userId || (await subordinateIds(db, userId)).has(supervisorId))) {
      throw new HttpError(400, 'لا يمكن أن يكون المسؤول المباشر أحد مرؤوسي هذا المستخدم');
    }
    const reports = await db.all('SELECT role FROM users WHERE supervisor_id = ? AND active = 1', userId);
    if (reports.some((r) => roleRank(r.role) <= roleRank(level))) {
      throw new HttpError(400, 'يوجد مرؤوسون لهذا المستخدم في مستوى مساوٍ أو أعلى من المستوى الجديد؛ يُرجى نقلهم أولًا');
    }
  }
}

async function withSupervisorName(db, user) {
  const out = publicUser(user);
  const sup = user.supervisor_id ? await getUser(db, user.supervisor_id) : null;
  out.supervisor_name = sup ? sup.name : null;
  return out;
}

const CREATOR_LEVELS = ['manager', 'team_leader', 'employee'];
const LOGIN_CHANNELS = ['whatsapp', 'sms', 'email'];
const MAX_CODE_ATTEMPTS = 5;
const CODE_MINUTES = 10;

function hashCode(userId, code) {
  return crypto.createHash('sha256').update(`login:${userId}:${code}`).digest('hex');
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

async function finishLogin(db, res, user, extra = {}) {
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(await auth.createSession(db, user.id)));
  return { user: await withSupervisorName(db, user), ...extra };
}

// Sends a login code on the preferred channel (falling back to the others); null when none is configured.
async function startLoginChallenge(db, messenger, config, user, preferred) {
  const available = LOGIN_CHANNELS.filter((c) => messenger.channels[c]);
  if (!available.length) return null;
  const order = available.includes(preferred) ? [preferred, ...available.filter((c) => c !== preferred)] : available;
  const phone = config.platformOwnerPhone || user.phone;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const token = crypto.randomBytes(24).toString('hex');
  const ts = now();
  await db.run('DELETE FROM login_challenges WHERE user_id = ?', user.id);
  let lastError = null;
  for (const channel of order) {
    if (channel !== 'email' && !phone) continue;
    try {
      await messenger.sendCode(channel, { email: user.email, phone, name: user.name, code, minutes: CODE_MINUTES, purpose: 'login' });
    } catch (err) {
      lastError = err;
      continue;
    }
    await db.run(`INSERT INTO login_challenges (token, user_id, code_hash, channel, expires_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)`,
      token, user.id, hashCode(user.id, code), channel, new Date(Date.now() + CODE_MINUTES * 60000).toISOString(), ts);
    return {
      challenge: token,
      channel,
      channels: available.filter((c) => c === 'email' || phone),
      destination: channel === 'email' ? maskEmail(user.email) : `+${maskPhone(phone)}`,
    };
  }
  throw lastError || new HttpError(400, 'لا توجد طريقة إرسال مفعّلة');
}

// Shared by first-run setup and signup: a new company and the account of the person registering it.
// The first company of a fresh installation (setup) is the host's own and never expires.
async function registerCompany({ db, body, res, config }, { firstRun = false } = {}) {
  const companyName = firstRun
    ? v.text(body.company_name, 'اسم الشركة', { required: false, max: 160 }) || config.appName || 'ابتكار'
    : v.text(body.company_name, 'اسم الشركة', { max: 160 });
  const name = v.text(body.name, 'الاسم', { max: 120 });
  const email = validateEmail(body.email);
  const password = validatePassword(body.password);
  const jobTitle = v.text(body.job_title, 'المسمى الوظيفي', { required: false, max: 120 });
  const creator = v.oneOf(body.creator_role || 'owner', ['owner', 'admin'], 'صفتك في الشركة');
  const level = creator === 'admin' ? v.oneOf(body.creator_level, CREATOR_LEVELS, 'دورك الوظيفي') : 'owner';
  const roles = creator === 'admin' ? [level, 'admin'] : ['owner'];
  const phone = await readPhone(db, body.phone, config);
  if (await emailTaken(db, email)) throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
  const platformOwner = isPlatformEmail(config, email);

  const user = await db.transaction(async (tx) => {
    const companyId = platformOwner || firstRun
      ? await createCompany(tx, { name: companyName, plan: 'owned' })
      : await createCompany(tx, { name: companyName, plan: 'trial', seats: config.trialSeats, days: config.trialDays });
    const r = await tx.run(`
      INSERT INTO users (name, email, password_hash, role, roles, job_title, phone, company_id, is_platform, supervisor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `, name, email, auth.hashPassword(password), level, roles.join(','), jobTitle, phone, companyId, platformOwner ? 1 : 0, now());
    if (!platformOwner) {
      for (const p of await platformAdmins(tx)) {
        await notify(tx, p.id, 'platform', `سجّلت شركة جديدة «${companyName}» وبدأت الفترة التجريبية`, `#/platform/companies/${companyId}`);
      }
    }
    return getUser(tx, r.lastInsertRowid);
  });
  return finishLogin(db, res, user);
}

module.exports = function register(router) {
  router.get('/api/setup-status', async ({ db }) => {
    const { n } = await db.get('SELECT EXISTS (SELECT 1 FROM users) AS n');
    return { needsSetup: n === 0 };
  }, { public: true });

  // First run (empty database) or self-service signup. The person registering is either the company
  // owner or its system admin with an organisational role; the owner can be added later in the latter case.
  router.post('/api/setup', async (ctx) => {
    const { n } = await ctx.db.get('SELECT EXISTS (SELECT 1 FROM users) AS n');
    if (n > 0) throw new HttpError(409, 'تم إعداد النظام مسبقًا');
    return registerCompany(ctx, { firstRun: true });
  }, { public: true });

  router.post('/api/signup', async (ctx) => {
    if (!ctx.config.allowSignup) throw new HttpError(403, 'التسجيل الذاتي غير متاح حاليًا؛ يُرجى التواصل مع إدارة منصة ابتكار');
    return registerCompany(ctx);
  }, { public: true });

  // The platform owner proves it is them with a code sent to their phone (WhatsApp/SMS) or email.
  router.post('/api/login', async ({ db, body, res, config, messenger }) => {
    const email = v.text(body.email, 'البريد الإلكتروني', { max: 200 }).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة');
    }
    if (!user.active) throw new HttpError(403, 'هذا الحساب موقوف، يُرجى التواصل مع مسؤول النظام');
    if (user.is_platform) {
      const challenge = await startLoginChallenge(db, messenger, config, user, body.channel);
      if (challenge) return { two_factor: true, ...challenge };
    }
    return finishLogin(db, res, user, { two_factor_unavailable: !!user.is_platform });
  }, { public: true });

  router.post('/api/login/verify', async ({ db, body, res }) => {
    const row = await db.get('SELECT * FROM login_challenges WHERE token = ?', String(body.challenge || ''));
    if (!row || row.expires_at < now()) throw new HttpError(400, 'انتهت صلاحية رمز الدخول؛ يُرجى تسجيل الدخول من جديد');
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      await db.run('DELETE FROM login_challenges WHERE token = ?', row.token);
      throw new HttpError(400, 'تجاوزت عدد المحاولات المسموح به؛ يُرجى تسجيل الدخول من جديد');
    }
    const code = String(body.code || '').replace(/\D/g, '');
    const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(row.user_id, code), 'hex'));
    if (!ok) {
      await db.run('UPDATE login_challenges SET attempts = attempts + 1 WHERE token = ?', row.token);
      throw new HttpError(400, `رمز الدخول غير صحيح؛ المحاولات المتبقية: ${MAX_CODE_ATTEMPTS - row.attempts - 1}`);
    }
    await db.run('DELETE FROM login_challenges WHERE user_id = ?', row.user_id);
    const user = await getUser(db, row.user_id);
    if (!user || !user.active) throw new HttpError(403, 'هذا الحساب موقوف');
    return finishLogin(db, res, user);
  }, { public: true });

  router.post('/api/login/resend', async ({ db, body, config, messenger }) => {
    const row = await db.get('SELECT * FROM login_challenges WHERE token = ?', String(body.challenge || ''));
    if (!row || row.expires_at < now()) throw new HttpError(400, 'انتهت صلاحية رمز الدخول؛ يُرجى تسجيل الدخول من جديد');
    const wait = 60 - Math.floor((Date.now() - Date.parse(row.sent_at)) / 1000);
    if (wait > 0) throw new HttpError(429, `يُرجى الانتظار ${wait} ثانية قبل طلب رمز جديد`);
    const user = await getUser(db, row.user_id);
    await db.run('DELETE FROM login_challenges WHERE token = ?', row.token);
    const challenge = await startLoginChallenge(db, messenger, config, user, body.channel);
    if (!challenge) throw new HttpError(400, 'لا توجد طريقة إرسال مفعّلة');
    return { two_factor: true, ...challenge };
  }, { public: true });

  router.post('/api/logout', async ({ db, cookies, res }) => {
    await auth.destroySession(db, cookies.sid);
    res.setHeader('Set-Cookie', auth.sessionCookie(null));
    return { ok: true };
  }, { public: true });

  // Includes the supervisor chain (nearest first) so reports can be shared with anyone above.
  router.get('/api/me', async ({ db, user }) => {
    const out = await withSupervisorName(db, user);
    out.has_team = (await subordinateIds(db, user.id)).size > 0 || user.role === 'owner';
    const chain = [];
    for (const id of await ancestorIds(db, user.id)) {
      const u = await getUser(db, id);
      chain.push({ id: u.id, name: u.name, job_title: u.job_title, role: u.role, phone: u.phone });
    }
    out.chain = chain;
    out.company = {
      id: user.company_id,
      name: user.company_name,
      plan: user.company_plan,
      plan_label: PLAN_LABELS[user.company_plan],
      ends_at: user.company_ends_at,
      seats: user.company_seats,
      ...accessOf(user),
      brand: await brandOf(db, user.company_id),
    };
    return { user: out };
  }, { ungated: true });

  // Everyone keeps their own WhatsApp number up to date.
  router.patch('/api/me', async ({ db, user, body, config }) => {
    const phone = await readPhone(db, body.phone, config, user.id);
    await db.run('UPDATE users SET phone = ? WHERE id = ?', phone, user.id);
    return { user: await withSupervisorName(db, await getUser(db, user.id)) };
  }, { ungated: true });

  // Everyone adds, changes or removes their own profile photo.
  router.post('/api/me/photo', async ({ db, user, body }) => {
    const { buf, mime } = decodeImage(body.data, 400 * 1024, 'الصورة');
    await db.transaction(async (tx) => {
      await tx.run(`INSERT INTO user_photos (user_id, data, mime, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, mime = excluded.mime, updated_at = excluded.updated_at`,
      user.id, buf, mime, now());
      await tx.run('UPDATE users SET photo_version = photo_version + 1 WHERE id = ?', user.id);
    });
    return { user: await withSupervisorName(db, await getUser(db, user.id)) };
  }, { ungated: true, maxBody: 1024 * 1024 });

  router.delete('/api/me/photo', async ({ db, user }) => {
    await db.run('DELETE FROM user_photos WHERE user_id = ?', user.id);
    await db.run('UPDATE users SET photo_version = 0 WHERE id = ?', user.id);
    return { user: await withSupervisorName(db, await getUser(db, user.id)) };
  }, { ungated: true });

  // Photos are seen by people of the same company (and the platform owner).
  router.get('/api/users/:id/photo', async ({ db, user, params, res }) => {
    const owner = await getUser(db, v.id(params.id, 'المستخدم'));
    const row = owner && (owner.company_id === user.company_id || user.is_platform)
      ? await db.get('SELECT data, mime FROM user_photos WHERE user_id = ?', owner.id) : null;
    if (!row) throw new HttpError(404, 'الصورة غير موجودة');
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    res.writeHead(200, {
      'Content-Type': row.mime, 'Content-Length': buf.length,
      'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  }, { ungated: true });

  // Anyone may delete their own account. A company owner who is alone in the company deletes the company with it.
  router.delete('/api/me', async ({ db, user, body, res }) => {
    if (!auth.verifyPassword(String(body.password || ''), user.password_hash)) {
      throw new HttpError(400, 'كلمة المرور غير صحيحة');
    }
    await assertDeletable(db, user, { allowSoleOwner: true });
    // The last person in a company takes the company with them.
    let deleted = 'account';
    if ((await liveCompanyUsers(db, user.company_id)) === 1) {
      await deleteCompany(db, user.company_id);
      deleted = 'company';
    } else {
      await deleteAccount(db, user, user);
    }
    res.setHeader('Set-Cookie', auth.sessionCookie(null));
    return { deleted };
  }, { ungated: true });

  // An in-app reminder (it rings like an alarm) to someone in my chain or my team.
  router.post('/api/users/:id/remind', async ({ db, user, params, body }) => {
    const target = await getUser(db, v.id(params.id, 'المستخدم'));
    if (!target || !target.active || target.company_id !== user.company_id) throw new HttpError(404, 'المستخدم غير موجود');
    const related = (await subordinateIds(db, user.id)).has(target.id) || (await ancestorIds(db, user.id)).includes(target.id);
    if (!related || target.id === user.id) throw new HttpError(403, 'يمكنك تذكير مسؤوليك أو أعضاء فريقك فقط');
    const message = v.text(body.message, 'نص التذكير', { max: 1000 });
    const recent = await db.get(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'nudge' AND link = ? AND created_at > ?`,
      target.id, `#/people?from=${user.id}`, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if (recent) throw new HttpError(429, 'أُرسل تذكير لهذا الشخص قبل قليل؛ يُرجى الانتظار عشر دقائق');
    await notify(db, target.id, 'nudge', `🔔 تذكير من ${user.name}: ${message}`, `#/people?from=${user.id}`);
    return { ok: true };
  });

  router.post('/api/me/password', async ({ db, user, body }) => {
    if (!auth.verifyPassword(String(body.current_password || ''), user.password_hash)) {
      throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
    }
    const password = validatePassword(body.new_password);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), user.id);
    return { ok: true };
  }, { ungated: true });

  // Admins see everyone; others see their supervisor chain, themselves and everyone below them.
  router.get('/api/users', async ({ db, user }) => {
    const admin = isAdmin(user);
    const subs = await subordinateIds(db, user.id);
    const all = await db.all('SELECT * FROM users WHERE company_id = ? AND deleted_at IS NULL', user.company_id);
    let visible = all;
    if (!admin && user.role !== 'owner') {
      const ids = new Set([user.id, ...(await ancestorIds(db, user.id)), ...subs]);
      visible = all.filter((u) => ids.has(u.id));
    }
    const names = new Map(all.map((u) => [u.id, u.name]));
    const users = visible.map((u) => ({
      ...publicUser(u),
      supervisor_name: names.get(u.supervisor_id) || null,
      in_my_team: subs.has(u.id),
      manageable: admin && (u.role !== 'owner' || u.id === user.id),
    }));
    users.sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, 'ar'));
    return { users, can_manage_accounts: admin, seats: { used: await activeSeats(db, user.company_id), total: user.company_seats } };
  });

  // Only the owner and system admins create accounts.
  router.post('/api/users', async ({ db, user, body, config }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'إنشاء الحسابات متاح لصاحب الشركة ومسؤول النظام فقط');
    const name = v.text(body.name, 'الاسم', { max: 120 });
    const email = validateEmail(body.email);
    const password = validatePassword(body.password);
    const jobTitle = v.text(body.job_title, 'المسمى الوظيفي', { required: false, max: 120 });
    // A company registered by its system admin may not have an owner yet; the admin can add one (only one).
    const asOwner = Array.isArray(body.roles) && body.roles.includes('owner');
    let roles; let level; let supervisorId = null;
    if (asOwner) {
      if (await db.get("SELECT 1 FROM users WHERE company_id = ? AND role = 'owner' AND deleted_at IS NULL", user.company_id)) {
        throw new HttpError(400, 'للشركة صاحب بالفعل');
      }
      roles = ['owner'];
      level = 'owner';
    } else {
      roles = validateRoles(body.roles);
      level = primaryRole(roles);
      supervisorId = await readSupervisor(db, body.supervisor_id, user.company_id);
      await checkPlacement(db, { level, supervisorId, companyId: user.company_id });
    }
    if (await emailTaken(db, email)) throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
    const phone = await readPhone(db, body.phone, config);
    await assertSeatAvailable(db, user.company_id);

    const r = await db.run(`
      INSERT INTO users (name, email, password_hash, role, roles, job_title, phone, company_id, is_platform, supervisor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, name, email, auth.hashPassword(password), level, roles.join(','), jobTitle, phone, user.company_id,
    isPlatformEmail(config, email) ? 1 : 0, supervisorId, now());
    // Whoever sat at the top until now (e.g. the admin who registered the company) reports to the new owner.
    if (asOwner) {
      await db.run('UPDATE users SET supervisor_id = ? WHERE company_id = ? AND supervisor_id IS NULL AND id != ? AND deleted_at IS NULL',
        r.lastInsertRowid, user.company_id, r.lastInsertRowid);
    }
    return { user: await withSupervisorName(db, await getUser(db, r.lastInsertRowid)) };
  });

  router.patch('/api/users/:id', async ({ db, user, params, body, config }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'إدارة الحسابات متاحة لصاحب الشركة ومسؤول النظام فقط');
    const target = await getUser(db, v.id(params.id, 'المستخدم'));
    if (!target || target.company_id !== user.company_id) throw new HttpError(404, 'المستخدم غير موجود');
    const isOwner = target.role === 'owner';
    if (isOwner && target.id !== user.id) throw new HttpError(403, 'لا يمكن تعديل حساب صاحب الشركة إلا من قِبله');

    const next = { ...target };
    if (body.name !== undefined) next.name = v.text(body.name, 'الاسم', { max: 120 });
    if (body.job_title !== undefined) next.job_title = v.text(body.job_title, 'المسمى الوظيفي', { required: false, max: 120 });
    if (body.email !== undefined) {
      next.email = validateEmail(body.email);
      if (await emailTaken(db, next.email, target.id)) throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
    }
    if (body.phone !== undefined) next.phone = await readPhone(db, body.phone, config, target.id);

    if (!isOwner && (body.roles !== undefined || body.supervisor_id !== undefined)) {
      const roles = body.roles !== undefined ? validateRoles(body.roles) : userRoles(target);
      if (target.id === user.id && !roles.includes('admin')) {
        throw new HttpError(400, 'لا يمكنك إزالة صلاحية مسؤول النظام من حسابك');
      }
      next.roles = roles.join(',');
      next.role = primaryRole(roles);
      next.supervisor_id = body.supervisor_id !== undefined ? await readSupervisor(db, body.supervisor_id, user.company_id) : target.supervisor_id;
      await checkPlacement(db, { userId: target.id, level: next.role, supervisorId: next.supervisor_id, companyId: user.company_id });
    }

    if (body.active !== undefined && !isOwner) {
      next.active = body.active ? 1 : 0;
      if (!next.active) {
        if (target.id === user.id) throw new HttpError(400, 'لا يمكنك إيقاف حسابك');
        const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE supervisor_id = ? AND active = 1', target.id);
        if (n > 0) throw new HttpError(400, 'لهذا المستخدم مرؤوسون نشطون؛ يُرجى نقلهم إلى مسؤول آخر أولًا');
      } else if (!target.active) {
        await assertSeatAvailable(db, user.company_id);
      }
    }

    await db.transaction(async (tx) => {
      await tx.run(`
        UPDATE users SET name = ?, email = ?, job_title = ?, phone = ?, role = ?, roles = ?, supervisor_id = ?, active = ?
        WHERE id = ?
      `, next.name, next.email, next.job_title, next.phone, next.role, next.roles, next.supervisor_id, next.active, target.id);
      if (body.password !== undefined && body.password !== '') {
        await tx.run('UPDATE users SET password_hash = ? WHERE id = ?',
          auth.hashPassword(validatePassword(body.password)), target.id);
        if (target.id !== user.id) await tx.run('DELETE FROM sessions WHERE user_id = ?', target.id);
      }
      if (!next.active) await tx.run('DELETE FROM sessions WHERE user_id = ?', target.id);
    });
    return { user: await withSupervisorName(db, await getUser(db, target.id)) };
  });
};
