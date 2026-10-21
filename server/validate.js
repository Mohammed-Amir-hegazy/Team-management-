'use strict';

const { HttpError } = require('./http');

function text(value, label, { required = true, max = 2000 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `قيمة «${label}» غير صحيحة`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `حقل «${label}» مطلوب`);
  if (value.length > max) throw new HttpError(400, `يتجاوز «${label}» الحد المسموح به (${max} حرفًا)`);
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new HttpError(400, `قيمة «${label}» غير صحيحة`);
  return value;
}

function id(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `قيمة «${label}» غير صحيحة`);
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
    throw new HttpError(400, `تاريخ «${label}» غير صحيح`);
  }
  return d.toISOString();
}

module.exports = { text, oneOf, id, optionalId, optionalDate };
