'use strict';

const { HttpError } = require('../http');
const v = require('../validate');
const { loadTask, canUpdateTaskStatus, canEditTask } = require('../access');
const { uploadSignature } = require('../cloudinary');
const { storeImage, sendImage, destroyImage } = require('../images');

const NOT_ALLOWED = 'ليست لديك صلاحية لتنفيذ هذا الإجراء';

// purpose=task: images supporting a task (people who work on it); purpose=report: images for a report.
async function uploadFolder(db, user, body) {
  const purpose = v.oneOf(body.purpose, ['task', 'report'], 'نوع الرفع');
  if (purpose === 'task') {
    const { task } = await loadTask(db, user, v.id(body.task_id, 'المهمة'));
    if (!(await canUpdateTaskStatus(db, user, task))) throw new HttpError(403, NOT_ALLOWED);
    return `ebtikar/tasks/${task.id}`;
  }
  return `ebtikar/reports/${user.id}`;
}

module.exports = function register(router) {
  // Cloudinary when configured; otherwise the browser sends each photo to /api/uploads/image.
  router.post('/api/uploads/sign', async ({ db, user, body, config }) => {
    const folder = await uploadFolder(db, user, body);
    if (!config.cloudinary) return { mode: 'local' };
    return { mode: 'cloudinary', ...uploadSignature(config, folder) };
  });

  router.post('/api/uploads/image', async ({ db, user, body }) => {
    await uploadFolder(db, user, body);
    return storeImage(db, user, body);
  }, { maxBody: 3 * 1024 * 1024 });

  router.get('/api/images/:id', ({ db, user, params, query, res }) => sendImage(db, user, params.id, query.get('size'), res), { ungated: true });

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
    await destroyImage(db, config, item.public_id);
    return { ok: true };
  });
};
