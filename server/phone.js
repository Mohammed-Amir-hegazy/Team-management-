'use strict';

const { HttpError } = require('./http');

// Phone numbers are stored as international digits without "+" (e.g. 201012345678),
// which is the form both WhatsApp links and SMS gateways expect.
function normalizePhone(value, defaultCountryCode = '20') {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  let digits = raw.replace(/[^\d+]/g, '').replace(/^\+/, '');
  digits = digits.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
  if (digits.length < 8 || digits.length > 15) {
    throw new HttpError(400, 'رقم الهاتف غير صحيح؛ يُرجى كتابته مع رمز الدولة، مثل: 201012345678+');
  }
  return digits;
}

function maskPhone(digits) {
  return digits ? `${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}` : '';
}

module.exports = { normalizePhone, maskPhone };
