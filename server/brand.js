'use strict';

// A company's identity used on its reports (screen, PDF and Excel): three colours, a font and a logo.
// Without one, reports use Ebtikar's identity.

const { HttpError } = require('./http');
const { now } = require('./db');

const DEFAULT_BRAND = { primary_color: '#06044B', secondary_color: '#5146E1', accent_color: '#62E98A', font: 'default' };

// Web fonts with full Arabic support (served by Google Fonts), plus Ebtikar's own and an uploaded file.
const FONTS = {
  default: 'خط ابتكار (DIN Next Arabic)',
  cairo: 'Cairo',
  tajawal: 'Tajawal',
  almarai: 'Almarai',
  'ibm-plex': 'IBM Plex Sans Arabic',
  'noto-kufi': 'Noto Kufi Arabic',
  readex: 'Readex Pro',
  changa: 'Changa',
  'el-messiri': 'El Messiri',
  amiri: 'Amiri',
  custom: 'خط مرفوع',
};

const MAX_LOGO = 600 * 1024;
const MAX_FONT = 2 * 1024 * 1024;

function hexColor(value, label) {
  const v = String(value || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new HttpError(400, `${label}: يُرجى اختيار لون صحيح`);
  return v.toUpperCase();
}

function decodeDataUrl(dataUrl, max, label) {
  const m = /^data:[\w.+/-]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, `${label} غير صالح`);
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) throw new HttpError(400, `${label} فارغ`);
  if (buf.length > max) throw new HttpError(413, `حجم ${label} أكبر من ${Math.round(max / 1024)} كيلوبايت`);
  return buf;
}

// The file's real type from its first bytes, whatever its name or data URL claims.
function logoType(buf) {
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.toString('utf8', 0, 600).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

function fontType(buf) {
  const sig = buf.toString('latin1', 0, 4);
  if (sig === 'wOF2') return 'font/woff2';
  if (sig === 'wOFF') return 'font/woff';
  if (sig === 'OTTO') return 'font/otf';
  if (sig === '\x00\x01\x00\x00' || sig === 'true') return 'font/ttf';
  return null;
}

async function brandRow(db, companyId) {
  return db.get(`SELECT company_id, primary_color, secondary_color, accent_color, font, font_name, version,
    logo IS NOT NULL AS has_logo, font_file IS NOT NULL AS has_font FROM company_brands WHERE company_id = ?`, companyId);
}

// What the interface needs to draw a company's reports.
async function brandOf(db, companyId) {
  const row = await brandRow(db, companyId);
  const b = { ...DEFAULT_BRAND, ...(row || {}) };
  const font = b.font === 'custom' && !row?.has_font ? 'default' : b.font;
  return {
    primary_color: b.primary_color,
    secondary_color: b.secondary_color,
    accent_color: b.accent_color,
    font,
    font_family: font === 'custom' ? (b.font_name || 'خط الشركة') : FONTS[font] || FONTS.default,
    font_url: font === 'custom' ? `/api/companies/${companyId}/brand/font?v=${b.version}` : null,
    logo_url: row?.has_logo ? `/api/companies/${companyId}/brand/logo?v=${b.version}` : null,
    custom: !!row,
  };
}

async function ensureRow(db, companyId) {
  await db.run(`INSERT INTO company_brands (company_id, updated_at) VALUES (?, ?)
    ON CONFLICT (company_id) DO NOTHING`, companyId, now());
}

async function saveBrand(db, companyId, body) {
  const colors = {
    primary_color: hexColor(body.primary_color, 'اللون الأساسي'),
    secondary_color: hexColor(body.secondary_color, 'اللون الثانوي'),
    accent_color: hexColor(body.accent_color, 'لون التمييز'),
  };
  const font = String(body.font || 'default');
  if (!FONTS[font]) throw new HttpError(400, 'الخط المختار غير متاح');
  await ensureRow(db, companyId);
  if (font === 'custom' && !(await brandRow(db, companyId)).has_font) throw new HttpError(400, 'يُرجى رفع ملف الخط أولًا');
  await db.run(`UPDATE company_brands SET primary_color = ?, secondary_color = ?, accent_color = ?, font = ?,
    version = version + 1, updated_at = ? WHERE company_id = ?`,
  colors.primary_color, colors.secondary_color, colors.accent_color, font, now(), companyId);
}

async function saveLogo(db, companyId, dataUrl) {
  const buf = decodeDataUrl(dataUrl, MAX_LOGO, 'ملف الشعار');
  const mime = logoType(buf);
  if (!mime) throw new HttpError(400, 'الشعار يجب أن يكون صورة PNG أو JPG أو WebP أو SVG');
  await ensureRow(db, companyId);
  await db.run('UPDATE company_brands SET logo = ?, logo_mime = ?, version = version + 1, updated_at = ? WHERE company_id = ?',
    buf, mime, now(), companyId);
}

async function saveFont(db, companyId, dataUrl, name) {
  const buf = decodeDataUrl(dataUrl, MAX_FONT, 'ملف الخط');
  const mime = fontType(buf);
  if (!mime) throw new HttpError(400, 'ملف الخط يجب أن يكون بصيغة WOFF2 أو WOFF أو TTF أو OTF');
  const fontName = String(name || '').replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'خط الشركة';
  await ensureRow(db, companyId);
  await db.run(`UPDATE company_brands SET font_file = ?, font_mime = ?, font_name = ?, font = 'custom', version = version + 1,
    updated_at = ? WHERE company_id = ?`, buf, mime, fontName, now(), companyId);
}

async function removeAsset(db, companyId, which) {
  if (which === 'logo') {
    await db.run('UPDATE company_brands SET logo = NULL, logo_mime = NULL, version = version + 1, updated_at = ? WHERE company_id = ?', now(), companyId);
  } else {
    await db.run(`UPDATE company_brands SET font_file = NULL, font_mime = NULL, font_name = '',
      font = CASE WHEN font = 'custom' THEN 'default' ELSE font END, version = version + 1, updated_at = ? WHERE company_id = ?`, now(), companyId);
  }
}

// Logos and fonts are versioned in their URLs, so they can be cached for good. An SVG logo may not run
// scripts even when opened directly.
async function sendAsset(db, companyId, which, res) {
  const row = which === 'logo'
    ? await db.get('SELECT logo AS data, logo_mime AS mime FROM company_brands WHERE company_id = ?', companyId)
    : await db.get('SELECT font_file AS data, font_mime AS mime FROM company_brands WHERE company_id = ?', companyId);
  if (!row || !row.data) throw new HttpError(404, 'الملف غير موجود');
  const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  res.writeHead(200, {
    'Content-Type': row.mime,
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(buf);
}

async function resetBrand(db, companyId) {
  await db.run('DELETE FROM company_brands WHERE company_id = ?', companyId);
}

module.exports = {
  DEFAULT_BRAND, FONTS, brandOf, saveBrand, saveLogo, saveFont, removeAsset, sendAsset, resetBrand, logoType, fontType,
};
