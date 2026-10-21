'use strict';

const { HttpError } = require('../http');
const v = require('../validate');
const { isAdmin } = require('../access');
const {
  FONTS, brandOf, saveBrand, saveLogo, saveFont, removeAsset, sendAsset, resetBrand,
} = require('../brand');

const NOT_ALLOWED = 'تعديل هوية الشركة متاح لصاحب الشركة ومسؤول النظام فقط';

function requireAdmin(user) {
  if (!isAdmin(user)) throw new HttpError(403, NOT_ALLOWED);
}

module.exports = function register(router) {
  router.get('/api/company/brand', async ({ db, user }) => ({ brand: await brandOf(db, user.company_id), fonts: FONTS }));

  router.patch('/api/company/brand', async ({ db, user, body }) => {
    requireAdmin(user);
    await saveBrand(db, user.company_id, body);
    return { brand: await brandOf(db, user.company_id) };
  });

  // Back to Ebtikar's identity (removes the logo and font too).
  router.delete('/api/company/brand', async ({ db, user }) => {
    requireAdmin(user);
    await resetBrand(db, user.company_id);
    return { brand: await brandOf(db, user.company_id) };
  });

  router.post('/api/company/brand/logo', async ({ db, user, body }) => {
    requireAdmin(user);
    await saveLogo(db, user.company_id, body.data);
    return { brand: await brandOf(db, user.company_id) };
  }, { maxBody: 1024 * 1024 });

  router.post('/api/company/brand/font', async ({ db, user, body }) => {
    requireAdmin(user);
    await saveFont(db, user.company_id, body.data, body.name);
    return { brand: await brandOf(db, user.company_id) };
  }, { maxBody: 3 * 1024 * 1024 });

  router.delete('/api/company/brand/:which', async ({ db, user, params }) => {
    requireAdmin(user);
    const which = v.oneOf(params.which, ['logo', 'font'], 'الملف');
    await removeAsset(db, user.company_id, which);
    return { brand: await brandOf(db, user.company_id) };
  });

  // Shown to the company's own people (and to the platform owner).
  router.get('/api/companies/:id/brand/:which', async ({ db, user, params, res }) => {
    const companyId = v.id(params.id, 'الشركة');
    if (companyId !== user.company_id && !user.is_platform) throw new HttpError(404, 'الملف غير موجود');
    await sendAsset(db, companyId, v.oneOf(params.which, ['logo', 'font'], 'الملف'), res);
  }, { ungated: true });
};
