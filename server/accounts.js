'use strict';

// Deleting an account or a whole company.
//
// An account is anonymised rather than removed: reports, requests and task history keep pointing at it
// (shown as «حساب محذوف»), while its personal details are wiped and its email becomes free to reuse.
// Its open work and its team move to its own supervisor so nothing is left without an owner.

const crypto = require('node:crypto');
const { HttpError } = require('./http');
const { now } = require('./db');
const { getUser, personalProject, addProjectMember, deleteProject, notify } = require('./access');
const { logEvent } = require('./subscription');

const DELETED_NAME = 'حساب محذوف';

async function liveCompanyUsers(db, companyId) {
  return (await db.get('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND deleted_at IS NULL', companyId)).n;
}

// Throws when deleting this account would leave the company or the platform without someone in charge.
async function assertDeletable(db, target, { allowSoleOwner = false } = {}) {
  if (!target || target.deleted_at) throw new HttpError(404, 'الحساب غير موجود');
  if (target.is_platform) {
    const { n } = await db.get('SELECT COUNT(*) AS n FROM users WHERE is_platform = 1 AND active = 1 AND deleted_at IS NULL AND id != ?', target.id);
    if (n === 0) throw new HttpError(400, 'لا يمكن حذف حساب مالك المنصة الوحيد');
  }
  if (target.role !== 'owner' && !target.supervisor_id
    && !(await db.get("SELECT 1 FROM users WHERE company_id = ? AND role = 'owner' AND deleted_at IS NULL", target.company_id))
    && (await db.get('SELECT 1 FROM users WHERE supervisor_id = ? AND deleted_at IS NULL', target.id))) {
    throw new HttpError(400, 'يتبع لهذا الحساب أشخاص ولا يوجد صاحب للشركة يُنقلون إليه؛ يُرجى إضافة صاحب الشركة أولًا');
  }
  if (target.role === 'owner') {
    if (!allowSoleOwner) throw new HttpError(400, 'لحذف صاحب الشركة يجب حذف الشركة بالكامل');
    if ((await liveCompanyUsers(db, target.company_id)) > 1) {
      throw new HttpError(400, 'لا يمكن حذف حساب صاحب الشركة ما دامت فيها حسابات أخرى؛ يُرجى حذفها أولًا أو التواصل مع إدارة المنصة');
    }
  }
}

async function deleteAccount(db, target, actor) {
  return db.transaction(async (tx) => {
    // Work moves to the supervisor, or (for someone at the top, e.g. an admin who registered the company)
    // to the company owner.
    const supervisor = target.supervisor_id ? await getUser(tx, target.supervisor_id)
      : await tx.get("SELECT * FROM users WHERE company_id = ? AND role = 'owner' AND deleted_at IS NULL AND id != ?", target.company_id, target.id);
    const ts = now();
    let moved = 0;

    if (supervisor) {
      // The team moves one level up (the supervisor is above everyone the target supervised).
      await tx.run('UPDATE users SET supervisor_id = ? WHERE supervisor_id = ?', supervisor.id, target.id);
      // Open work goes to the supervisor; standalone tasks into the supervisor's own standalone tasks.
      const personal = await tx.get('SELECT id FROM projects WHERE personal_owner_id = ?', target.id);
      const open = await tx.all("SELECT id, project_id FROM tasks WHERE assignee_id = ? AND status != 'done'", target.id);
      const supPersonal = open.some((t) => personal && t.project_id === personal.id) ? await personalProject(tx, supervisor) : null;
      for (const t of open) {
        const projectId = personal && t.project_id === personal.id ? supPersonal.id : t.project_id;
        await tx.run('UPDATE tasks SET assignee_id = ?, project_id = ?, updated_at = ? WHERE id = ?', supervisor.id, projectId, ts, t.id);
        await addProjectMember(tx, projectId, supervisor.id);
        await tx.run(`INSERT INTO task_status_history (task_id, user_id, from_status, to_status, note, created_at)
          SELECT id, ?, status, status, ?, ? FROM tasks WHERE id = ?`, actor.id, `أُعيد إسنادها بعد حذف حساب ${target.name}`, ts, t.id);
        moved++;
      }
      // Requests still waiting on the target now wait on the supervisor.
      await tx.run("UPDATE requests SET recipient_id = ? WHERE recipient_id = ? AND status = 'pending'", supervisor.id, target.id);
      await notify(tx, supervisor.id, 'task', moved
        ? `حُذف حساب ${target.name}، وأُسندت إليك مهامه المفتوحة (${moved}) وفريقه وطلباته المعلّقة`
        : `حُذف حساب ${target.name}، وانتقل فريقه وطلباته المعلّقة إليك`, '#/tasks');
    }

    await tx.run('DELETE FROM requirements WHERE requested_by = ? AND request_id IS NULL', target.id);
    await tx.run('DELETE FROM project_members WHERE user_id = ?', target.id);
    await tx.run('DELETE FROM sessions WHERE user_id = ?', target.id);
    await tx.run('DELETE FROM notifications WHERE user_id = ?', target.id);
    await tx.run('DELETE FROM password_resets WHERE user_id = ?', target.id);
    await tx.run('DELETE FROM user_photos WHERE user_id = ?', target.id);
    const placeholder = `deleted-${target.id}-${crypto.randomBytes(4).toString('hex')}@deleted.invalid`;
    await tx.run(`UPDATE users SET name = ?, email = ?, phone = '', job_title = '', password_hash = '!', active = 0,
      is_platform = 0, photo_version = 0, deleted_at = ? WHERE id = ?`, DELETED_NAME, placeholder, ts, target.id);
    await logEvent(tx, target.company_id, 'user_deleted', target.id === actor.id ? `${target.name} (بطلب منه)` : target.name,
      target.id === actor.id ? null : actor.id);
    return { moved_tasks: moved };
  });
}

// Removes a company and everything in it. Not allowed for a company that has platform owners.
async function deleteCompany(db, companyId) {
  if (await db.get('SELECT 1 FROM users WHERE company_id = ? AND is_platform = 1 AND deleted_at IS NULL', companyId)) {
    throw new HttpError(400, 'لا يمكن حذف شركة تضم حساب مالك المنصة');
  }
  await db.transaction(async (tx) => {
    for (const p of await tx.all('SELECT id FROM projects WHERE company_id = ?', companyId)) await deleteProject(tx, p.id);
    const inCompany = 'SELECT id FROM users WHERE company_id = ?';
    // Reports first (attachments and forwarding chains), then everything tied to the people.
    const reportIds = `SELECT id FROM reports WHERE sender_id IN (${inCompany}) OR recipient_id IN (${inCompany})`;
    await tx.run(`DELETE FROM attachments WHERE report_id IN (${reportIds})`, companyId, companyId);
    await tx.run(`UPDATE reports SET forwarded_from_id = NULL WHERE forwarded_from_id IN (${reportIds})`, companyId, companyId);
    await tx.run(`DELETE FROM reports WHERE sender_id IN (${inCompany}) OR recipient_id IN (${inCompany})`, companyId, companyId);
    await tx.run(`UPDATE requests SET forwarded_from_id = NULL, root_id = NULL WHERE sender_id IN (${inCompany}) OR recipient_id IN (${inCompany})`, companyId, companyId);
    await tx.run(`DELETE FROM requirements WHERE requested_by IN (${inCompany})`, companyId);
    await tx.run(`DELETE FROM requests WHERE sender_id IN (${inCompany}) OR recipient_id IN (${inCompany})`, companyId, companyId);
    await tx.run(`DELETE FROM attachments WHERE uploaded_by IN (${inCompany})`, companyId);
    await tx.run(`DELETE FROM task_status_history WHERE user_id IN (${inCompany})`, companyId);
    for (const table of ['notifications', 'sessions', 'password_resets', 'project_members', 'user_photos']) {
      await tx.run(`DELETE FROM ${table} WHERE user_id IN (${inCompany})`, companyId);
    }
    await tx.run('DELETE FROM images WHERE company_id = ?', companyId);
    await tx.run('DELETE FROM company_brands WHERE company_id = ?', companyId);
    await tx.run('DELETE FROM subscription_events WHERE company_id = ?', companyId);
    await tx.run('UPDATE subscription_events SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
    await tx.run('UPDATE users SET supervisor_id = NULL WHERE company_id = ?', companyId);
    await tx.run('DELETE FROM users WHERE company_id = ?', companyId);
    await tx.run('DELETE FROM companies WHERE id = ?', companyId);
  });
}

module.exports = { DELETED_NAME, assertDeletable, deleteAccount, deleteCompany, liveCompanyUsers };
