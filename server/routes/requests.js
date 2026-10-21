'use strict';

const { HttpError } = require('../http');
const { now } = require('../db');
const v = require('../validate');
const { requireSupervisor, subordinateIds, notify } = require('../access');

// Items always hang off the original request of a forwarding chain: COALESCE(root_id, id).
const REQUEST_SQL = `
  SELECT q.*, s.name AS sender_name, s.company_id AS sender_company_id, r.name AS recipient_name, r.phone AS recipient_phone, r.job_title AS recipient_job_title,
    s.phone AS sender_phone, CASE WHEN p.personal_owner_id IS NULL THEN p.name ELSE 'مهمة مستقلة' END AS project_name, t.title AS task_title,
    (SELECT COUNT(*) FROM requirements x WHERE x.request_id = COALESCE(q.root_id, q.id)) AS items_count
  FROM requests q
  JOIN users s ON s.id = q.sender_id
  JOIN users r ON r.id = q.recipient_id
  JOIN projects p ON p.id = q.project_id
  LEFT JOIN tasks t ON t.id = q.task_id
`;

// Sender and recipient can act on a request; anyone above the sender may read it.
async function loadRequest(db, user, requestId) {
  const request = await db.get(`${REQUEST_SQL} WHERE q.id = ?`, requestId);
  const involved = request && (request.sender_id === user.id || request.recipient_id === user.id);
  if (!request || (!involved && !(user.role === 'owner' && request.sender_company_id === user.company_id)
    && !(await subordinateIds(db, user.id)).has(request.sender_id))) {
    throw new HttpError(404, 'الطلب غير موجود');
  }
  return request;
}

function rootOf(request) {
  return request.root_id || request.id;
}

module.exports = function register(router) {
  // box: inbox (sent to me), sent (by me), team (sent by anyone below me, read-only).
  router.get('/api/requests', async ({ db, user, query }) => {
    const box = query.get('box');
    const order = "ORDER BY q.status != 'pending', q.created_at DESC LIMIT 200";
    if (box === 'team') {
      const team = [...(await subordinateIds(db, user.id))];
      if (!team.length) return { requests: [] };
      const ph = team.map(() => '?').join(',');
      return { requests: await db.all(`${REQUEST_SQL} WHERE q.sender_id IN (${ph}) AND q.root_id IS NULL ${order}`, ...team) };
    }
    const column = box === 'sent' ? 'q.sender_id' : 'q.recipient_id';
    return { requests: await db.all(`${REQUEST_SQL} WHERE ${column} = ? ${order}`, user.id) };
  });

  router.get('/api/requests/:id', async ({ db, user, params }) => {
    const request = await loadRequest(db, user, v.id(params.id, 'المتطلب'));
    const items = await db.all(`
      SELECT r.*, t.title AS task_title, u.name AS requested_by_name
      FROM requirements r JOIN tasks t ON t.id = r.task_id JOIN users u ON u.id = r.requested_by
      WHERE r.request_id = ? ORDER BY t.title, r.id
    `, rootOf(request));
    // The path this request travelled, from the original requester upward.
    const chain = await db.all(`
      SELECT q.id, s.name AS sender_name, r.name AS recipient_name, q.status, q.note, q.created_at
      FROM requests q JOIN users s ON s.id = q.sender_id JOIN users r ON r.id = q.recipient_id
      WHERE COALESCE(q.root_id, q.id) = ? ORDER BY q.id
    `, rootOf(request));
    return {
      request,
      items,
      chain,
      permissions: {
        respond: request.recipient_id === user.id && request.status === 'pending',
        forward: request.recipient_id === user.id && request.status === 'pending' && !!user.supervisor_id,
        remind: request.sender_id === user.id && request.status === 'pending',
      },
    };
  });

  // Approving/rejecting settles the whole chain, so the answer reaches the original sender.
  router.post('/api/requests/:id/respond', async ({ db, user, params, body }) => {
    const request = await loadRequest(db, user, v.id(params.id, 'المتطلب'));
    if (request.recipient_id !== user.id) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    if (request.status !== 'pending') throw new HttpError(400, 'تم الرد على هذا الطلب مسبقًا');
    const decision = v.oneOf(body.decision, ['approved', 'rejected'], 'القرار');
    const note = v.text(body.note, 'الرد', { required: decision === 'rejected', max: 2000 });
    const label = decision === 'approved' ? 'بالموافقة على' : 'برفض';

    await db.transaction(async (tx) => {
      const chain = await tx.all('SELECT id, sender_id FROM requests WHERE COALESCE(root_id, id) = ?', rootOf(request));
      await tx.run('UPDATE requests SET status = ?, response_note = ?, responded_at = ? WHERE COALESCE(root_id, id) = ?',
        decision, note, now(), rootOf(request));
      for (const link of chain) {
        await notify(tx, link.sender_id, 'request_response',
          `قام ${user.name} ${label} طلبك${note ? `: ${note}` : ''}`, `#/requests/${link.id}`);
      }
    });
    return { ok: true };
  });

  // The sender nudges the recipient about a request still waiting for an answer.
  router.post('/api/requests/:id/remind', async ({ db, user, params, body }) => {
    const request = await loadRequest(db, user, v.id(params.id, 'الطلب'));
    if (request.sender_id !== user.id) throw new HttpError(403, 'يمكن لمرسل الطلب فقط التذكير به');
    if (request.status !== 'pending') throw new HttpError(400, 'تم الرد على هذا الطلب أو إحالته');
    const message = v.text(body.message, 'نص التذكير', { required: false, max: 1000 });
    const link = `#/requests/${request.id}`;
    const recent = await db.get(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'nudge' AND link = ? AND created_at > ?`,
      request.recipient_id, link, new Date(Date.now() - 30 * 60 * 1000).toISOString());
    if (recent) throw new HttpError(429, 'أُرسل تذكير بهذا الطلب قبل قليل؛ يُرجى الانتظار نصف ساعة');
    await notify(db, request.recipient_id, 'nudge',
      `🔔 يذكّركم ${user.name} بطلب المتطلبات المرسل بانتظار ردّكم${message ? `: ${message}` : ''}`, link);
    return { ok: true };
  });

  // Passing it one step up the chain (never skipping a level).
  router.post('/api/requests/:id/forward', async ({ db, user, params, body }) => {
    const request = await loadRequest(db, user, v.id(params.id, 'المتطلب'));
    if (request.recipient_id !== user.id) throw new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذا الإجراء');
    if (request.status !== 'pending') throw new HttpError(400, 'تم الرد على هذا الطلب مسبقًا');
    const supervisor = await requireSupervisor(db, user);
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 2000 });

    const id = await db.transaction(async (tx) => {
      const r = await tx.run(`
        INSERT INTO requests (sender_id, recipient_id, scope, project_id, task_id, note, forwarded_from_id, root_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, user.id, supervisor.id, request.scope, request.project_id, request.task_id, note, request.id, rootOf(request), now());
      await tx.run("UPDATE requests SET status = 'forwarded' WHERE id = ?", request.id);
      await notify(tx, supervisor.id, 'request', `أحال إليك ${user.name} طلبًا مقدَّمًا من ${request.sender_name}`, `#/requests/${r.lastInsertRowid}`);
      await notify(tx, request.sender_id, 'request_response', `أحال ${user.name} طلبك إلى ${supervisor.name}`, `#/requests/${request.id}`);
      return r.lastInsertRowid;
    });
    return { request_id: id };
  });
};
