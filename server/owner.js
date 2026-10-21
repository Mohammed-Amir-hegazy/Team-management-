'use strict';

// The platform has exactly one owner, identified by email (PLATFORM_OWNER_EMAIL). Whatever the data says,
// that account — and only that account — gets the platform dashboard, and its own company never expires.

const { logEvent } = require('./subscription');

function isPlatformEmail(config, email) {
  return !!email && String(email).trim().toLowerCase() === config.platformOwnerEmail;
}

async function syncPlatformOwner(db, config) {
  const email = config.platformOwnerEmail;
  await db.run('UPDATE users SET is_platform = 0 WHERE is_platform = 1 AND email != ?', email);
  await db.run('UPDATE users SET is_platform = 1 WHERE email = ? AND deleted_at IS NULL AND is_platform = 0', email);
  const company = await db.get(`SELECT c.* FROM companies c JOIN users u ON u.company_id = c.id
    WHERE u.email = ? AND u.deleted_at IS NULL`, email);
  if (company && (company.plan !== 'owned' || company.status !== 'active')) {
    await db.run("UPDATE companies SET plan = 'owned', ends_at = NULL, status = 'active', reminded_stages = '' WHERE id = ?", company.id);
    await logEvent(db, company.id, 'owned', 'شركة مالك المنصة: ملكية دائمة');
  }
}

module.exports = { isPlatformEmail, syncPlatformOwner };
