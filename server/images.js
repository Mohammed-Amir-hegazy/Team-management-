'use strict';

// Task and report photos. With Cloudinary configured, browsers upload straight to it; otherwise the
// photos (already resized in the browser) are kept in our own database, so uploads always work.

const crypto = require('node:crypto');
const { HttpError } = require('./http');
const { now } = require('./db');
const cloudinary = require('./cloudinary');

const MAX_IMAGE = 1.5 * 1024 * 1024;
const MAX_THUMB = 200 * 1024;
const LOCAL_PREFIX = '/api/images/';

// Only real JPEG / PNG / WebP files, whatever the data URL claims.
function sniff(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function decode(dataUrl, max, label) {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, `${label} غير صالحة`);
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > max) throw new HttpError(413, `حجم ${label} أكبر من الحد المسموح به`);
  const mime = sniff(buf);
  if (!mime) throw new HttpError(400, `${label} ليست صورة مدعومة (JPEG أو PNG أو WebP)`);
  return { buf, mime };
}

// A profile photo or other small picture: JPEG, PNG or WebP only.
function decodeImage(dataUrl, max, label) {
  return decode(dataUrl, max, label);
}

async function storeImage(db, user, body) {
  const full = decode(body.data, MAX_IMAGE, 'الصورة');
  const thumb = body.thumb ? decode(body.thumb, MAX_THUMB, 'الصورة المصغّرة') : full;
  const id = crypto.randomBytes(18).toString('base64url');
  const width = Number.isInteger(body.width) ? body.width : null;
  const height = Number.isInteger(body.height) ? body.height : null;
  await db.run(`INSERT INTO images (id, company_id, uploaded_by, mime, data, thumb_mime, thumb, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, user.company_id, user.id, full.mime, full.buf, thumb.mime, thumb.buf, full.buf.length, now());
  return { url: `${LOCAL_PREFIX}${id}`, public_id: `local:${id}`, width, height };
}

const toBuffer = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value));

// Photos are only shown to people of the same company (and to the platform owner).
async function sendImage(db, user, id, size, res) {
  const row = await db.get('SELECT * FROM images WHERE id = ?', id);
  if (!row || (row.company_id !== user.company_id && !user.is_platform)) throw new HttpError(404, 'الصورة غير موجودة');
  const thumb = size === 'thumb';
  const buf = toBuffer(thumb ? row.thumb : row.data);
  res.writeHead(200, {
    'Content-Type': thumb ? row.thumb_mime : row.mime,
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

// Images in a task or report must be ones this person just uploaded (ours or Cloudinary's).
async function validateImages(db, config, user, items, max = 10) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'لم يتم اختيار أي صورة');
  if (items.length > max) throw new HttpError(400, `يمكن إرفاق ${max} صور كحد أقصى في المرة الواحدة`);
  const out = [];
  for (const item of items) {
    const url = String(item && item.url || '');
    if (url.startsWith(LOCAL_PREFIX)) {
      const id = url.slice(LOCAL_PREFIX.length);
      const row = await db.get('SELECT uploaded_by FROM images WHERE id = ?', id);
      if (!row || row.uploaded_by !== user.id) throw new HttpError(400, 'رابط الصورة غير صالح');
      out.push({
        url, public_id: `local:${id}`,
        width: Number.isInteger(item.width) ? item.width : null,
        height: Number.isInteger(item.height) ? item.height : null,
      });
    } else {
      out.push(...cloudinary.validateImages(config, [item], max));
    }
  }
  return out;
}

async function destroyImage(db, config, publicId) {
  if (String(publicId).startsWith('local:')) {
    await db.run('DELETE FROM images WHERE id = ?', publicId.slice(6));
    return;
  }
  await cloudinary.destroyImage(config, publicId);
}

// Photos that were uploaded but never attached, or whose task/report is gone.
async function purgeOrphanImages(db, olderThanMs = 24 * 3600 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const r = await db.run(`DELETE FROM images WHERE created_at < ? AND NOT EXISTS
    (SELECT 1 FROM attachments a WHERE a.public_id = 'local:' || images.id)`, cutoff);
  return r.changes;
}

module.exports = { storeImage, sendImage, validateImages, destroyImage, purgeOrphanImages, decodeImage };
