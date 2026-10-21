'use strict';

const path = require('node:path');
const { Router, HttpError, readJson, parseCookies, sendJson, serveStatic } = require('./http');
const { userFromSession } = require('./auth');
const { loadConfig } = require('./config');
const { createMessenger } = require('./messaging');

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function createApp(db, {
  publicDir = path.join(__dirname, '..', 'public'),
  config = loadConfig(),
  messenger = createMessenger(),
} = {}) {
  const router = new Router();
  // For uptime checks and keep-awake pings: never touches the database.
  router.get('/api/health', () => ({ ok: true }), { public: true });
  // Which optional integrations are switched on, so the interface only offers what works.
  router.get('/api/client-config', () => ({ otp: messenger.channels, uploads: !!config.cloudinary }), { public: true });
  require('./routes/users')(router);
  require('./routes/projects')(router);
  require('./routes/tasks')(router);
  require('./routes/requests')(router);
  require('./routes/reports')(router);
  require('./routes/notifications')(router);
  require('./routes/password')(router);
  require('./routes/uploads')(router);

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
        ctx.body = await readJson(req);
      }
      ctx.user = await userFromSession(db, ctx.cookies.sid);
      if (!found.route.options.public && !ctx.user) throw new HttpError(401, 'يُرجى تسجيل الدخول أولًا');
      const result = await found.route.handler(ctx);
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'حدث خطأ غير متوقع، يُرجى المحاولة مرة أخرى' });
      }
    }
  };
}

module.exports = { createApp };
