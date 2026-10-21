'use strict';

// Browsers upload images straight to Cloudinary using a short-lived signature from us,
// so files never pass through our server and the API secret never leaves it.

const crypto = require('node:crypto');
const { HttpError } = require('./http');
const v = require('./validate');

function requireCloudinary(config) {
  if (!config.cloudinary) throw new HttpError(503, 'رفع الصور غير مفعّل؛ يُرجى التواصل مع مسؤول النظام');
  return config.cloudinary;
}

// Cloudinary's scheme: sha1 of the alphabetically sorted "key=value" pairs joined by "&", plus the secret.
function sign(params, secret) {
  const payload = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(payload + secret).digest('hex');
}

function uploadSignature(config, folder) {
  const c = requireCloudinary(config);
  const timestamp = Math.floor(Date.now() / 1000);
  return { cloud_name: c.cloud_name, api_key: c.api_key, timestamp, folder, signature: sign({ folder, timestamp }, c.api_secret) };
}

// Only accept images that really live in our Cloudinary account.
function validateImages(config, items, max = 10) {
  const c = requireCloudinary(config);
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'لم يتم اختيار أي صورة');
  if (items.length > max) throw new HttpError(400, `يمكن إرفاق ${max} صور كحد أقصى في المرة الواحدة`);
  const prefix = `https://res.cloudinary.com/${c.cloud_name}/image/upload/`;
  return items.map((item) => {
    const url = String(item && item.url || '');
    if (!url.startsWith(prefix)) throw new HttpError(400, 'رابط الصورة غير صالح');
    return {
      url,
      public_id: v.text(item.public_id, 'معرّف الصورة', { max: 300 }),
      width: Number.isInteger(item.width) ? item.width : null,
      height: Number.isInteger(item.height) ? item.height : null,
    };
  });
}

// Best effort: a failed remote delete only leaves an orphaned file behind.
async function destroyImage(config, publicId) {
  if (!config.cloudinary) return;
  const fetchImpl = config.fetch || globalThis.fetch;
  const c = config.cloudinary;
  const timestamp = Math.floor(Date.now() / 1000);
  const form = new URLSearchParams({
    public_id: publicId, timestamp: String(timestamp), api_key: c.api_key,
    signature: sign({ public_id: publicId, timestamp }, c.api_secret),
  });
  try {
    await fetchImpl(`https://api.cloudinary.com/v1_1/${c.cloud_name}/image/destroy`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    });
  } catch (err) {
    console.error('Cloudinary destroy failed:', err.message);
  }
}

module.exports = { sign, uploadSignature, validateImages, destroyImage, requireCloudinary };
