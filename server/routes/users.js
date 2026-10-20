'use strict';

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const auth = require('../auth');
const {
  ROLES, roleRank, getUser, subordinateIds, ancestorIds, publicUser,
} = require('../access');

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw new HttpError(400, 'كلمة المرور لازم تكون 6 حروف على الأقل');
  }
  return password;
}

async function insertUser(db, { name, email, password, role, supervisorId }) {
  if (await db.get('SELECT 1 FROM users WHERE email = ?', email)) {
    throw new HttpError(409, 'البريد الإلكتروني مستخدم بالفعل');
  }
  const result = await db.run(`
    INSERT INTO users (name, email, password_hash, role, supervisor_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, name, email, auth.hashPassword(password), role, supervisorId, now());
  return getUser(db, result.lastInsertRowid);
}

function readUserFields(body) {
  const email = v.text(body.email, 'البريد الإلكتروني', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'البريد الإلكتروني غير صحيح');
  return {
    name: v.text(body.name, 'الاسم', { max: 120 }),
    email,
    password: validatePassword(body.password),
  };
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

  // First run only: creates the company owner.
  router.post('/api/setup', async ({ db, body, res }) => {
    const fields = readUserFields(body);
    const user = await db.transaction(async (tx) => {
      const { n } = await tx.get('SELECT EXISTS (SELECT 1 FROM users) AS n');
      if (n > 0) throw new HttpError(409, 'تم إعداد النظام بالفعل');
      return insertUser(tx, { ...fields, role: 'owner', supervisorId: null });
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
    if (!user.active) throw new HttpError(403, 'هذا الحساب موقوف');
    res.setHeader('Set-Cookie', auth.sessionCookie(await auth.createSession(db, user.id)));
    return { user: await withSupervisorName(db, user) };
  }, { public: true });

  router.post('/api/logout', async ({ db, cookies, res }) => {
    await auth.destroySession(db, cookies.sid);
    res.setHeader('Set-Cookie', auth.sessionCookie(null));
    return { ok: true };
  }, { public: true });

  router.get('/api/me', async ({ db, user }) => ({ user: await withSupervisorName(db, user) }));

  router.post('/api/me/password', async ({ db, user, body }) => {
    if (!auth.verifyPassword(String(body.current_password || ''), user.password_hash)) {
      throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
    }
    const password = validatePassword(body.new_password);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), user.id);
    return { ok: true };
  });

  // People this user may see: their supervisor chain, themselves and everyone below them.
  router.get('/api/users', async ({ db, user }) => {
    const subs = await subordinateIds(db, user.id);
    const all = await db.all('SELECT * FROM users');
    let visible = all;
    if (user.role !== 'owner') {
      const ids = new Set([user.id, ...(await ancestorIds(db, user.id)), ...subs]);
      visible = all.filter((u) => ids.has(u.id));
    }
    const names = new Map(all.map((u) => [u.id, u.name]));
    const users = visible.map((u) => ({
      ...publicUser(u),
      supervisor_name: names.get(u.supervisor_id) || null,
      manageable: subs.has(u.id),
    }));
    users.sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, 'ar'));
    return { users };
  });

  // Supervisors create people below them. A supervisor must be exactly one level above.
  router.post('/api/users', async ({ db, user, body }) => {
    const fields = readUserFields(body);
    const role = v.oneOf(body.role, ROLES.slice(1), 'الدور');
    if (roleRank(role) <= roleRank(user.role)) {
      throw new HttpError(403, 'لا يمكنك إضافة شخص في نفس مستواك أو أعلى منك');
    }
    const supervisorId = v.id(body.supervisor_id ?? user.id, 'المسؤول المباشر');
    const supervisor = await getUser(db, supervisorId);
    if (!supervisor || !supervisor.active) throw new HttpError(400, 'المسؤول المباشر غير موجود');
    if (roleRank(supervisor.role) !== roleRank(role) - 1) {
      throw new HttpError(400, 'المسؤول المباشر لازم يكون في المستوى اللي فوقه مباشرة');
    }
    if (supervisorId !== user.id && !(await subordinateIds(db, user.id)).has(supervisorId)) {
      throw new HttpError(403, 'المسؤول المباشر لازم يكون أنت أو حد تحتك');
    }
    const created = await insertUser(db, { ...fields, role, supervisorId });
    return { user: await withSupervisorName(db, created) };
  });

  // Anyone above a user can rename, reset password, or suspend/reactivate them.
  router.patch('/api/users/:id', async ({ db, user, params, body }) => {
    const targetId = v.id(params.id, 'المستخدم');
    if (!(await subordinateIds(db, user.id)).has(targetId)) throw new HttpError(403, 'غير مسموح');
    if (body.name !== undefined) {
      await db.run('UPDATE users SET name = ? WHERE id = ?', v.text(body.name, 'الاسم', { max: 120 }), targetId);
    }
    if (body.password !== undefined) {
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?',
        auth.hashPassword(validatePassword(body.password)), targetId);
      await db.run('DELETE FROM sessions WHERE user_id = ?', targetId);
    }
    if (body.active !== undefined) {
      const active = body.active ? 1 : 0;
      if (!active) {
        const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE supervisor_id = ? AND active = 1', targetId);
        if (n > 0) throw new HttpError(400, 'لازم تنقل أو توقف الأشخاص اللي تحته الأول');
        await db.run('DELETE FROM sessions WHERE user_id = ?', targetId);
      }
      await db.run('UPDATE users SET active = ? WHERE id = ?', active, targetId);
    }
    return { user: await withSupervisorName(db, await getUser(db, targetId)) };
  });
};
