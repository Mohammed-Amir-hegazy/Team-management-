'use strict';

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const auth = require('../auth');
const {
  ROLES, roleRank, userRoles, isAdmin, primaryRole, getUser, subordinateIds, ancestorIds, publicUser, notify,
} = require('../access');
const { normalizePhone } = require('../phone');

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

// A supervisor must sit at a higher level, and nobody may end up supervising themselves.
async function checkPlacement(db, { userId = null, level, supervisorId }) {
  const supervisor = await getUser(db, supervisorId);
  if (!supervisor || !supervisor.active) throw new HttpError(400, 'المسؤول المباشر المحدد غير موجود');
  if (roleRank(supervisor.role) >= roleRank(level)) {
    throw new HttpError(400, 'يجب أن يكون المسؤول المباشر في مستوى وظيفي أعلى');
  }
  if (userId) {
    if (supervisorId === userId || (await subordinateIds(db, userId)).has(supervisorId)) {
      throw new HttpError(400, 'لا يمكن أن يكون المسؤول المباشر أحد مرؤوسي هذا المستخدم');
    }
    const reports = await db.all('SELECT role FROM users WHERE supervisor_id = ? AND active = 1', userId);
    if (reports.some((r) => roleRank(r.role) <= roleRank(level))) {
      throw new HttpError(400, 'يوجد مرؤوسون لهذا المستخدم في مستوى مساوٍ أو أعلى من المستوى الجديد؛ يُرجى نقلهم أولًا');
    }
  }
  return supervisor;
}

async function withSupervisorName(db, user) {
  const out = publicUser(user);
  const sup = user.supervisor_id ? await getUser(db, user.supervisor_id) : null;
  out.supervisor_name = sup ? sup.name : null;
  return out;
}

module.exports = function register(router) {
  router.get('/api/setup-status', async ({ db }) => {
    const { n } = await db.get('SELECT EXISTS (SELECT 1 FROM users) AS n');
    return { needsSetup: n === 0 };
  }, { public: true });

  // First run only: creates the company owner, who is also the first system admin.
  router.post('/api/setup', async ({ db, body, res, config }) => {
    const name = v.text(body.name, 'الاسم', { max: 120 });
    const email = validateEmail(body.email);
    const password = validatePassword(body.password);
    const jobTitle = v.text(body.job_title, 'المسمى الوظيفي', { required: false, max: 120 });
    const phone = await readPhone(db, body.phone, config);
    const user = await db.transaction(async (tx) => {
      const { n } = await tx.get('SELECT EXISTS (SELECT 1 FROM users) AS n');
      if (n > 0) throw new HttpError(409, 'تم إعداد النظام مسبقًا');
      const r = await tx.run(`
        INSERT INTO users (name, email, password_hash, role, roles, job_title, phone, supervisor_id, created_at)
        VALUES (?, ?, ?, 'owner', 'owner', ?, ?, NULL, ?)
      `, name, email, auth.hashPassword(password), jobTitle, phone, now());
      return getUser(tx, r.lastInsertRowid);
    });
    res.setHeader('Set-Cookie', auth.sessionCookie(await auth.createSession(db, user.id)));
    return { user: await withSupervisorName(db, user) };
  }, { public: true });

  router.post('/api/login', async ({ db, body, res }) => {
    const email = v.text(body.email, 'البريد الإلكتروني', { max: 200 }).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة');
    }
    if (!user.active) throw new HttpError(403, 'هذا الحساب موقوف، يُرجى التواصل مع مسؤول النظام');
    res.setHeader('Set-Cookie', auth.sessionCookie(await auth.createSession(db, user.id)));
    return { user: await withSupervisorName(db, user) };
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
    return { user: out };
  });

  // Everyone keeps their own WhatsApp number up to date.
  router.patch('/api/me', async ({ db, user, body, config }) => {
    const phone = await readPhone(db, body.phone, config, user.id);
    await db.run('UPDATE users SET phone = ? WHERE id = ?', phone, user.id);
    return { user: await withSupervisorName(db, await getUser(db, user.id)) };
  });

  // An in-app reminder (it rings like an alarm) to someone in my chain or my team.
  router.post('/api/users/:id/remind', async ({ db, user, params, body }) => {
    const target = await getUser(db, v.id(params.id, 'المستخدم'));
    if (!target || !target.active) throw new HttpError(404, 'المستخدم غير موجود');
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
  });

  // Admins see everyone; others see their supervisor chain, themselves and everyone below them.
  router.get('/api/users', async ({ db, user }) => {
    const admin = isAdmin(user);
    const subs = await subordinateIds(db, user.id);
    const all = await db.all('SELECT * FROM users');
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
    return { users, can_manage_accounts: admin };
  });

  // Only the owner and system admins create accounts.
  router.post('/api/users', async ({ db, user, body, config }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'إنشاء الحسابات متاح لصاحب الشركة ومسؤول النظام فقط');
    const name = v.text(body.name, 'الاسم', { max: 120 });
    const email = validateEmail(body.email);
    const password = validatePassword(body.password);
    const jobTitle = v.text(body.job_title, 'المسمى الوظيفي', { required: false, max: 120 });
    const roles = validateRoles(body.roles);
    const level = primaryRole(roles);
    const supervisorId = v.id(body.supervisor_id, 'المسؤول المباشر');
    await checkPlacement(db, { level, supervisorId });
    if (await emailTaken(db, email)) throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
    const phone = await readPhone(db, body.phone, config);

    const r = await db.run(`
      INSERT INTO users (name, email, password_hash, role, roles, job_title, phone, supervisor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, name, email, auth.hashPassword(password), level, roles.join(','), jobTitle, phone, supervisorId, now());
    return { user: await withSupervisorName(db, await getUser(db, r.lastInsertRowid)) };
  });

  router.patch('/api/users/:id', async ({ db, user, params, body, config }) => {
    if (!isAdmin(user)) throw new HttpError(403, 'إدارة الحسابات متاحة لصاحب الشركة ومسؤول النظام فقط');
    const target = await getUser(db, v.id(params.id, 'المستخدم'));
    if (!target) throw new HttpError(404, 'المستخدم غير موجود');
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
      next.supervisor_id = body.supervisor_id !== undefined ? v.id(body.supervisor_id, 'المسؤول المباشر') : target.supervisor_id;
      await checkPlacement(db, { userId: target.id, level: next.role, supervisorId: next.supervisor_id });
    }

    if (body.active !== undefined && !isOwner) {
      next.active = body.active ? 1 : 0;
      if (!next.active) {
        if (target.id === user.id) throw new HttpError(400, 'لا يمكنك إيقاف حسابك');
        const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE supervisor_id = ? AND active = 1', target.id);
        if (n > 0) throw new HttpError(400, 'لهذا المستخدم مرؤوسون نشطون؛ يُرجى نقلهم إلى مسؤول آخر أولًا');
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
