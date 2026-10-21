'use strict';

// Outgoing email / SMS / WhatsApp through HTTP APIs (no SMTP, which free hosts often block).
//   Email:    BREVO_API_KEY or RESEND_API_KEY, with MAIL_FROM (and optional MAIL_FROM_NAME)
//   SMS:      TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM
//   WhatsApp: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM

const { HttpError } = require('./http');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Branded, right-to-left email used for verification codes.
function codeEmail({ name, code, minutes, purpose = 'reset' }) {
  const why = purpose === 'login'
    ? 'تلقّينا طلب تسجيل دخول إلى حسابك على منصة ابتكار. لإكمال الدخول استخدم رمز التحقق التالي:'
    : 'تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك على منصة ابتكار. استخدم رمز التحقق التالي:';
  const ignore = purpose === 'login'
    ? 'إذا لم تكن أنت من يحاول الدخول فغيّر كلمة المرور فورًا.'
    : 'إذا لم تطلب ذلك فتجاهل هذه الرسالة؛ ستبقى كلمة المرور دون تغيير.';
  const html = `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#F4F4FB;font-family:Tahoma,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden">
      <tr><td style="background:#06044B;padding:22px 28px;text-align:left;direction:ltr">
        <span style="color:#fff;font-size:24px;font-weight:bold;letter-spacing:1px">EBTIKAR</span>
        <span style="display:block;color:#62E98A;font-size:12px">software solutions</span></td></tr>
      <tr><td style="padding:28px;color:#0B0A3A;text-align:right">
        <p style="margin:0 0 12px;font-size:16px">${esc(name)}، تحية طيبة،</p>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.8">${why}</p>
        <div style="text-align:center;margin:0 0 18px"><span style="display:inline-block;direction:ltr;background:#ECEBFD;color:#5146E1;
          font-size:32px;font-weight:bold;letter-spacing:10px;padding:14px 22px;border-radius:12px">${esc(code)}</span></div>
        <p style="margin:0 0 6px;font-size:13px;color:#6E6C93">الرمز صالح لمدة ${minutes} دقائق، ولا يُستخدم إلا مرة واحدة.</p>
        <p style="margin:0;font-size:13px;color:#6E6C93">${ignore}</p>
      </td></tr>
      <tr><td style="background:#F7F7FD;padding:14px 28px;font-size:12px;color:#6E6C93;text-align:center">منصة ابتكار لإدارة الأعمال — Ebtikar Software Solutions</td></tr>
    </table></td></tr></table></body></html>`;
  const text = `${name}، تحية طيبة،\n${why} ${code}\nالرمز صالح لمدة ${minutes} دقائق. ${ignore}`;
  return { subject: purpose === 'login' ? 'رمز تسجيل الدخول — منصة ابتكار' : 'رمز التحقق — منصة ابتكار', html, text };
}

function noticeEmail({ name, subject, text }) {
  const html = `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#F4F4FB;font-family:Tahoma,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden">
      <tr><td style="background:#06044B;padding:22px 28px;text-align:left;direction:ltr">
        <span style="color:#fff;font-size:24px;font-weight:bold;letter-spacing:1px">EBTIKAR</span>
        <span style="display:block;color:#62E98A;font-size:12px">software solutions</span></td></tr>
      <tr><td style="padding:28px;color:#0B0A3A;text-align:right">
        <p style="margin:0 0 12px;font-size:16px">${esc(name)}، تحية طيبة،</p>
        <p style="margin:0;font-size:15px;line-height:1.9">${esc(text)}</p></td></tr>
      <tr><td style="background:#F7F7FD;padding:14px 28px;font-size:12px;color:#6E6C93;text-align:center">منصة ابتكار لإدارة الأعمال — Ebtikar Software Solutions</td></tr>
    </table></td></tr></table></body></html>`;
  return { subject, html, text: `${name}، تحية طيبة،\n${text}` };
}

function createMessenger(env = process.env, fetchImpl = globalThis.fetch) {
  const from = env.MAIL_FROM;
  const fromName = env.MAIL_FROM_NAME || 'منصة ابتكار';
  const email = env.BREVO_API_KEY && from ? 'brevo' : env.RESEND_API_KEY && from ? 'resend' : null;
  const twilio = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN;
  // Testing only: OTP_DEV_LOG=1 prints codes to the server log instead of sending them.
  const devLog = env.OTP_DEV_LOG === '1' && !email;
  const channels = {
    email: !!email || devLog,
    sms: !!(twilio && env.TWILIO_SMS_FROM),
    whatsapp: !!(twilio && env.TWILIO_WHATSAPP_FROM),
  };

  async function call(url, init, label) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      console.error(`${label} request failed:`, err.message);
      throw new HttpError(502, 'تعذّر الاتصال بخدمة الإرسال، يُرجى المحاولة لاحقًا');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`${label} responded ${res.status}: ${detail.slice(0, 300)}`);
      throw new HttpError(502, 'تعذّر إرسال الرسالة، يُرجى المحاولة لاحقًا أو التواصل مع مسؤول النظام');
    }
  }

  async function sendEmail({ to, name, subject, html, text }) {
    if (email === 'brevo') {
      return call('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { name: fromName, email: from }, to: [{ email: to, name }], subject, htmlContent: html, textContent: text }),
      }, 'Brevo');
    }
    return call('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, html, text }),
    }, 'Resend');
  }

  async function sendTwilio(to, body, whatsapp) {
    const fromDigits = String(whatsapp ? env.TWILIO_WHATSAPP_FROM : env.TWILIO_SMS_FROM).replace(/^whatsapp:/, '').replace(/\D/g, '');
    const prefix = whatsapp ? 'whatsapp:' : '';
    const form = new URLSearchParams({ To: `${prefix}+${to}`, From: `${prefix}+${fromDigits}`, Body: body });
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    return call(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }, whatsapp ? 'Twilio WhatsApp' : 'Twilio SMS');
  }

  return {
    channels,
    // A plain notice by email (e.g. subscription renewal); silently skipped when no provider is set.
    async sendNotice({ email: address, name, subject, text }) {
      if (!email) return false;
      await sendEmail({ to: address, name, ...noticeEmail({ name, subject, text }) });
      return true;
    },
    async sendCode(channel, { email: address, phone, name, code, minutes, purpose = 'reset' }) {
      if (!channels[channel]) throw new HttpError(400, 'طريقة الإرسال المختارة غير مفعّلة');
      if (channel === 'email' && devLog) { console.log(`[OTP_DEV_LOG] ${address}: ${code}`); return undefined; }
      if (channel === 'email') return sendEmail({ to: address, name, ...codeEmail({ name, code, minutes, purpose }) });
      const text = purpose === 'login'
        ? `منصة ابتكار: رمز تسجيل الدخول إلى حسابك هو ${code}، وهو صالح لمدة ${minutes} دقائق. لا تشاركه مع أحد.`
        : `منصة ابتكار: رمز التحقق لإعادة تعيين كلمة المرور هو ${code}، وهو صالح لمدة ${minutes} دقائق. لا تشاركه مع أحد.`;
      return sendTwilio(phone, text, channel === 'whatsapp');
    },
  };
}

module.exports = { createMessenger, codeEmail };
