'use strict';

const { HttpError } = require('./http');

function text(value, label, { required = true, max = 2000 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}: قيمة غير صحيحة`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `${label} مطلوب`);
  if (value.length > max) throw new HttpError(400, `${label} أطول من المسموح (${max} حرف)`);
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new HttpError(400, `${label}: قيمة غير صحيحة`);
  return value;
}

function id(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label}: قيمة غير صحيحة`);
  return n;
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return id(value, label);
}

// Accepts any date string the JS Date parser understands and stores it as UTC ISO.
function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) {
    throw new HttpError(400, `${label}: تاريخ غير صحيح`);
  }
  return d.toISOString();
}

module.exports = { text, oneOf, id, optionalId, optionalDate };
