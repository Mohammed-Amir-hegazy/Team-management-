'use strict';

const { HttpError } = require('../http');
const { now, transaction } = require('../db');
const v = require('../validate');
const { requireSupervisor, notify } = require('../access');
const { rootRequestId } = require('../requirements');

const REQUEST_SQL = `
  SELECT q.*, s.name AS sender_name, r.name AS recipient_name, p.name AS project_name, t.title AS task_title
  FROM requests q
  JOIN users s ON s.id = q.sender_id
  JOIN users r ON r.id = q.recipient_id
  JOIN projects p ON p.id = q.project_id
  LEFT JOIN tasks t ON t.id = q.task_id
`;

function itemCount(db, request) {
  const rootId = rootRequestId(db, request.id);
  return db.prepare('SELECT COUNT(*) AS n FROM requirements WHERE request_id = ?').get(rootId).n;
}

function loadRequest(db, user, requestId) {
  const request = db.prepare(`${REQUEST_SQL} WHERE q.id = ?`).get(requestId);
  if (!request || (request.sender_id !== user.id && request.recipient_id !== user.id)) {
    throw new HttpError(404, 'الطلب غير موجود');
  }
  return request;
}

module.exports = function register(router) {
  router.get('/api/requests', ({ db, user, query }) => {
    const box = query.get('box') === 'sent' ? 'sent' : 'inbox';
    const column = box === 'sent' ? 'q.sender_id' : 'q.recipient_id';
    const requests = db.prepare(`${REQUEST_SQL} WHERE ${column} = ? ORDER BY q.status != 'pending', q.created_at DESC`)
      .all(user.id)
      .map((r) => ({ ...r, items_count: itemCount(db, r) }));
    return { requests };
  });

  router.get('/api/requests/:id', ({ db, user, params }) => {
    const request = loadRequest(db, user, v.id(params.id, 'الطلب'));
    const rootId = rootRequestId(db, request.id);
    const items = db.prepare(`
      SELECT r.*, t.title AS task_title, u.name AS requested_by_name
      FROM requirements r JOIN tasks t ON t.id = r.task_id JOIN users u ON u.id = r.requested_by
      WHERE r.request_id = ? ORDER BY t.title, r.id
    `).all(rootId);
    // The chain this request travelled through, from the original requester upward.
    const chain = [];
    let cur = db.prepare(`${REQUEST_SQL} WHERE q.id = ?`).get(rootId);
    while (cur) {
      chain.push({ id: cur.id, sender_name: cur.sender_name, recipient_name: cur.recipient_name,
        status: cur.status, note: cur.note, created_at: cur.created_at });
      cur = db.prepare(`${REQUEST_SQL} WHERE q.forwarded_from_id = ?`).get(cur.id);
    }
    return {
      request: { ...request, items_count: items.length },
      items,
      chain,
      permissions: {
        respond: request.recipient_id === user.id && request.status === 'pending',
        forward: request.recipient_id === user.id && request.status === 'pending' && !!user.supervisor_id,
      },
    };
  });

  // Approving/rejecting also settles every request it was forwarded from, down to the original sender.
  router.post('/api/requests/:id/respond', ({ db, user, params, body }) => {
    const request = loadRequest(db, user, v.id(params.id, 'الطلب'));
    if (request.recipient_id !== user.id) throw new HttpError(403, 'غير مسموح');
    if (request.status !== 'pending') throw new HttpError(400, 'تم الرد على هذا الطلب بالفعل');
    const decision = v.oneOf(body.decision, ['approved', 'rejected'], 'القرار');
    const note = v.text(body.note, 'الرد', { required: decision === 'rejected', max: 2000 });
    const label = decision === 'approved' ? 'وافق على' : 'رفض';

    transaction(db, () => {
      const ts = now();
      let cur = db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id);
      while (cur) {
        db.prepare('UPDATE requests SET status = ?, response_note = ?, responded_at = ? WHERE id = ?')
          .run(decision, note, ts, cur.id);
        notify(db, cur.sender_id, 'request_response',
          `${user.name} ${label} طلبك${note ? ` — ${note}` : ''}`, `#/requests/${cur.id}`);
        cur = cur.forwarded_from_id
          ? db.prepare('SELECT * FROM requests WHERE id = ?').get(cur.forwarded_from_id) : null;
      }
    });
    return { ok: true };
  });

  // Passing it one step up the chain (never skipping a level).
  router.post('/api/requests/:id/forward', ({ db, user, params, body }) => {
    const request = loadRequest(db, user, v.id(params.id, 'الطلب'));
    if (request.recipient_id !== user.id) throw new HttpError(403, 'غير مسموح');
    if (request.status !== 'pending') throw new HttpError(400, 'تم الرد على هذا الطلب بالفعل');
    const supervisor = requireSupervisor(db, user);
    const note = v.text(body.note, 'الملاحظة', { required: false, max: 2000 });

    const id = transaction(db, () => {
      const r = db.prepare(`
        INSERT INTO requests (sender_id, recipient_id, scope, project_id, task_id, note, forwarded_from_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, supervisor.id, request.scope, request.project_id, request.task_id, note, request.id, now());
      db.prepare("UPDATE requests SET status = 'forwarded' WHERE id = ?").run(request.id);
      const newId = Number(r.lastInsertRowid);
      notify(db, supervisor.id, 'request', `${user.name} حوّل لك طلب من ${request.sender_name}`, `#/requests/${newId}`);
      notify(db, request.sender_id, 'request_response', `${user.name} حوّل طلبك لـ ${supervisor.name}`, `#/requests/${request.id}`);
      return newId;
    });
    return { request_id: id };
  });
};
