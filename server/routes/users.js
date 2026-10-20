'use strict';

const { HttpError } = require('../http');
const { now, transaction } = require('../db');
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

function insertUser(db, { name, email, password, role, supervisorId }) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'البريد الإلكتروني مستخدم بالفعل');
  }
  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, supervisor_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, email, auth.hashPassword(password), role, supervisorId, now());
  return getUser(db, Number(result.lastInsertRowid));
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

function withSupervisorName(db, user) {
  const out = publicUser(user);
  const sup = user.supervisor_id ? getUser(db, user.supervisor_id) : null;
  out.supervisor_name = sup ? sup.name : null;
  return out;
}

module.exports = function register(router) {
  router.get('/api/setup-status', ({ db }) => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    return { needsSetup: n === 0 };
  }, { public: true });

  // First run only: creates the company owner.
  router.post('/api/setup', ({ db, body, res }) => {
    const fields = readUserFields(body);
    const user = transaction(db, () => {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
      if (n > 0) throw new HttpError(409, 'تم إعداد النظام بالفعل');
      return insertUser(db, { ...fields, role: 'owner', supervisorId: null });
    });
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.createSession(db, user.id)));
    return { user: withSupervisorName(db, user) };
  }, { public: true });

  router.post('/api/login', ({ db, body, res }) => {
    const email = v.text(body.email, 'البريد الإلكتروني', { max: 200 }).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة');
    }
    if (!user.active) throw new HttpError(403, 'هذا الحساب موقوف');
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.createSession(db, user.id)));
    return { user: withSupervisorName(db, user) };
  }, { public: true });

  router.post('/api/logout', ({ db, cookies, res }) => {
    auth.destroySession(db, cookies.sid);
    res.setHeader('Set-Cookie', auth.sessionCookie(null));
    return { ok: true };
  }, { public: true });

  router.get('/api/me', ({ db, user }) => ({ user: withSupervisorName(db, user) }));

  router.post('/api/me/password', ({ db, user, body }) => {
    if (!auth.verifyPassword(String(body.current_password || ''), user.password_hash)) {
      throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
    }
    const password = validatePassword(body.new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), user.id);
    return { ok: true };
  });

  // People this user may see: their supervisor chain, themselves and everyone below them.
  router.get('/api/users', ({ db, user }) => {
    let ids;
    if (user.role === 'owner') {
      ids = db.prepare('SELECT id FROM users').all().map((r) => r.id);
    } else {
      ids = [user.id, ...ancestorIds(db, user.id), ...subordinateIds(db, user.id)];
    }
    const subs = subordinateIds(db, user.id);
    const users = ids.map((id) => getUser(db, id)).map((u) => ({
      ...withSupervisorName(db, u),
      manageable: subs.has(u.id),
    }));
    users.sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, 'ar'));
    return { users };
  });

  // Supervisors create people below them. A supervisor must be exactly one level above.
  router.post('/api/users', ({ db, user, body }) => {
    const fields = readUserFields(body);
    const role = v.oneOf(body.role, ROLES.slice(1), 'الدور');
    if (roleRank(role) <= roleRank(user.role)) {
      throw new HttpError(403, 'لا يمكنك إضافة شخص في نفس مستواك أو أعلى منك');
    }
    const supervisorId = v.id(body.supervisor_id ?? user.id, 'المسؤول المباشر');
    const supervisor = getUser(db, supervisorId);
    if (!supervisor || !supervisor.active) throw new HttpError(400, 'المسؤول المباشر غير موجود');
    if (roleRank(supervisor.role) !== roleRank(role) - 1) {
      throw new HttpError(400, 'المسؤول المباشر لازم يكون في المستوى اللي فوقه مباشرة');
    }
    if (supervisorId !== user.id && !subordinateIds(db, user.id).has(supervisorId)) {
      throw new HttpError(403, 'المسؤول المباشر لازم يكون أنت أو حد تحتك');
    }
    const created = insertUser(db, { ...fields, role, supervisorId });
    return { user: withSupervisorName(db, created) };
  });

  // Anyone above a user can rename, reset password, or suspend/reactivate them.
  router.patch('/api/users/:id', ({ db, user, params, body }) => {
    const targetId = v.id(params.id, 'المستخدم');
    if (!subordinateIds(db, user.id).has(targetId)) throw new HttpError(403, 'غير مسموح');
    const target = getUser(db, targetId);
    if (body.name !== undefined) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(v.text(body.name, 'الاسم', { max: 120 }), targetId);
    }
    if (body.password !== undefined) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(auth.hashPassword(validatePassword(body.password)), targetId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    }
    if (body.active !== undefined) {
      const active = body.active ? 1 : 0;
      if (!active) {
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM users WHERE supervisor_id = ? AND active = 1').get(targetId);
        if (n > 0) throw new HttpError(400, 'لازم تنقل أو توقف الأشخاص اللي تحته الأول');
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      }
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, target.id);
    }
    return { user: withSupervisorName(db, getUser(db, targetId)) };
  });
};
