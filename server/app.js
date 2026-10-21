'use strict';

const path = require('node:path');
const { Router, HttpError, readJson, parseCookies, sendJson, serveStatic } = require('./http');
const { userFromSession } = require('./auth');
const { loadConfig } = require('./config');
const { createMessenger } = require('./messaging');
const { accessOf, accessError } = require('./subscription');

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function createApp(db, {
  publicDir = path.join(__dirname, '..', 'public'),
  config: overrides = {},
  messenger = createMessenger(),
} = {}) {
  const config = { ...loadConfig(), ...overrides };
  const router = new Router();
  // For uptime checks and keep-awake pings: never touches the database.
  router.get('/api/health', () => ({ ok: true }), { public: true });
  // Which optional integrations are switched on, so the interface only offers what works.
  router.get('/api/client-config', () => ({
    otp: messenger.channels, uploads: true, signup: !!config.allowSignup, trial_days: config.trialDays,
    storage_warning: config.storageWarning || null,
  }), { public: true });
  require('./routes/users')(router);
  require('./routes/projects')(router);
  require('./routes/tasks')(router);
  require('./routes/requests')(router);
  require('./routes/reports')(router);
  require('./routes/notifications')(router);
  require('./routes/password')(router);
  require('./routes/uploads')(router);
  require('./routes/subscription')(router);
  require('./routes/platform')(router);

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      serveStatic(res, publicDir, url.pathname);
      return;
    }

    try {
      const found = router.match(req.method, url.pathname);
      if (!found) throw new HttpError(404, 'المسار المطلوب غير موجود');
      const ctx = {
        req, res, db, config, messenger,
        params: found.params,
        query: url.searchParams,
        cookies: parseCookies(req),
        body: {},
        user: null,
      };
      if (MUTATING.has(req.method)) {
        // A JSON content type cannot be sent cross-site without a CORS preflight, which blocks CSRF.
        const type = req.headers['content-type'] || '';
        if (!type.startsWith('application/json')) throw new HttpError(415, 'يجب إرسال البيانات بصيغة JSON');
        ctx.body = await readJson(req, found.route.options.maxBody);
      }
      ctx.user = await userFromSession(db, ctx.cookies.sid);
      if (!found.route.options.public && !ctx.user) throw new HttpError(401, 'يُرجى تسجيل الدخول أولًا');
      // An expired or suspended company keeps only its account, notification and subscription pages.
      if (!found.route.options.public && !found.route.options.ungated) {
        const access = accessOf(ctx.user);
        if (!access.ok) throw accessError(access.reason);
      }
      const result = await found.route.handler(ctx);
      // Handlers that stream a file (images) answer by themselves.
      if (res.headersSent) return;
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.reason ? { reason: err.reason } : {}) });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'حدث خطأ غير متوقع، يُرجى المحاولة مرة أخرى' });
      }
    }
  };
}

module.exports = { createApp };
