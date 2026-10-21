import {
  $, $$, esc, icon, api, render, setTitle, setFab, attempt, relTime, emptyState,
} from '../core.js';

const TYPE_ICONS = {
  reminder: 'bell', overdue: 'clock', task: 'tasks', status: 'tasks', blocked: 'alert', project: 'folder',
  report: 'report', report_reply: 'reply', request: 'box', request_response: 'box',
};

export async function viewNotifications() {
  setTitle('الإشعارات');
  const { notifications, unread } = await api('GET', '/api/notifications');
  const canAsk = 'Notification' in window && Notification.permission === 'default';
  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>الإشعارات</h1><div class="sub">${unread ? `${unread} غير مقروءة` : 'لا توجد إشعارات جديدة'}</div></div>
      <div class="actions">
        ${canAsk ? `<button class="btn subtle" id="enable-push">${icon('bell')}تفعيل تنبيهات المتصفح</button>` : ''}
        ${unread ? `<button class="btn ghost" id="read-all">${icon('check')}تحديد الكل كمقروء</button>` : ''}
      </div>
    </div>
    <section class="card">
      ${notifications.length ? `<div class="list stagger">${notifications.map((n, i) => `
        <div class="item link ${n.read_at ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link)}" style="--i:${Math.min(i, 12)}">
          <span class="kpi-ic" style="width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;
            background:${n.type === 'overdue' || n.type === 'blocked' ? 'var(--danger-soft)' : 'var(--primary-soft)'};
            color:${n.type === 'overdue' || n.type === 'blocked' ? 'var(--danger)' : 'var(--primary)'}">${icon(TYPE_ICONS[n.type] || 'bell')}</span>
          <div class="grow"><div class="title">${esc(n.message)}</div><div class="meta">${esc(relTime(n.created_at))}</div></div>
        </div>`).join('')}</div>` : emptyState('لا توجد إشعارات', 'ستظهر هنا تنبيهات المهام والتقارير والطلبات.')}
    </section>`);

  const readAll = $('#read-all', el);
  if (readAll) readAll.addEventListener('click', () => attempt(async () => {
    await api('POST', '/api/notifications/read-all', {});
    viewNotifications();
  }));
  const push = $('#enable-push', el);
  if (push) push.addEventListener('click', async () => { await Notification.requestPermission(); viewNotifications(); });
  $$('[data-id]', el).forEach((item) => item.addEventListener('click', async () => {
    await api('POST', `/api/notifications/${item.dataset.id}/read`, {}).catch(() => {});
    if (item.dataset.link) location.hash = item.dataset.link;
    else viewNotifications();
  }));
  setFab(null);
}
