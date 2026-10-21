'use strict';

const { HttpError } = require('../http');
const v = require('../validate');
const { loadTask, canUpdateTaskStatus, canEditTask } = require('../access');
const { uploadSignature, destroyImage } = require('../cloudinary');

const NOT_ALLOWED = 'ليست لديك صلاحية لتنفيذ هذا الإجراء';

module.exports = function register(router) {
  // purpose=task: images supporting a task (people who work on it); purpose=report: images for a report.
  router.post('/api/uploads/sign', async ({ db, user, body, config }) => {
    const purpose = v.oneOf(body.purpose, ['task', 'report'], 'نوع الرفع');
    if (purpose === 'task') {
      const { task } = await loadTask(db, user, v.id(body.task_id, 'المهمة'));
      if (!(await canUpdateTaskStatus(db, user, task))) throw new HttpError(403, NOT_ALLOWED);
      return uploadSignature(config, `ebtikar/tasks/${task.id}`);
    }
    return uploadSignature(config, `ebtikar/reports/${user.id}`);
  });

  router.delete('/api/attachments/:id', async ({ db, user, params, config }) => {
    const item = await db.get('SELECT * FROM attachments WHERE id = ?', v.id(params.id, 'الصورة'));
    if (!item) throw new HttpError(404, 'الصورة غير موجودة');
    let allowed = item.uploaded_by === user.id;
    if (!allowed && item.task_id) {
      const { task } = await loadTask(db, user, item.task_id);
      allowed = await canEditTask(db, user, task);
    }
    if (!allowed) throw new HttpError(403, NOT_ALLOWED);
    await db.run('DELETE FROM attachments WHERE id = ?', item.id);
    await destroyImage(config, item.public_id);
    return { ok: true };
  });
};
