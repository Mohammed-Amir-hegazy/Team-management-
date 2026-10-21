import {
  state, $, esc, icon, api, render, setTitle, setFab, toast, openModal,
  REQUEST_STATUS, pill, avatar, tabs, onTabs, remember, relTime, fmtDateTime, emptyState, plural, ITEMS_N,
} from '../core.js';

export async function viewRequests({ query }) {
  setTitle('الطلبات');
  const boxes = [['inbox', 'الوارد'], ['sent', 'المرسل']];
  if (state.me.has_team) boxes.push(['team', 'طلبات الفريق']);
  let box = query.get('box') || remember('requestBox') || 'inbox';
  if (!boxes.some(([k]) => k === box)) box = 'inbox';
  remember('requestBox', box);
  const { requests } = await api('GET', `/api/requests?box=${box}`);

  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>الطلبات</h1>
        <div class="sub">تُضاف المتطلبات من صفحة كل مهمة، وتُرسل دفعة واحدة للمهمة أو للمشروع بالكامل</div></div>
    </div>
    ${tabs(boxes, box)}
    <section class="card">
      ${requests.length ? `<div class="list stagger">${requests.map((q, i) => {
        const person = box === 'sent' ? { name: q.recipient_name, id: q.recipient_id } : { name: q.sender_name, id: q.sender_id };
        return `<div class="item link" data-href="#/requests/${q.id}" style="--i:${Math.min(i, 12)}">
          ${avatar(person.name, person.id)}
          <div class="grow">
            <div class="title">${q.scope === 'project' ? `جميع متطلبات مشروع «${esc(q.project_name)}»` : `متطلبات المهمة «${esc(q.task_title)}»`}</div>
            <div class="meta">${box === 'sent' ? `إلى ${esc(q.recipient_name)}` : box === 'team' ? `${esc(q.sender_name)} ← ${esc(q.recipient_name)}` : `من ${esc(q.sender_name)}`}
              · ${plural(q.items_count, ITEMS_N)} · ${esc(relTime(q.created_at))}${q.forwarded_from_id ? ' · مُحال' : ''}</div>
          </div>
          ${pill(REQUEST_STATUS[q.status])}
        </div>`;
      }).join('')}</div>` : emptyState(box === 'inbox' ? 'لا توجد طلبات بانتظار ردك' : 'لا توجد طلبات',
        box === 'sent' ? 'أضف المتطلبات من صفحة المهمة ثم أرسلها بضغطة زر.' : '')}
    </section>`);
  onTabs(el, (tab) => { location.hash = `#/requests?box=${tab}`; });
  setFab(null);
}

export async function viewRequest({ id }) {
  const { request: q, items, chain, permissions: can } = await api('GET', `/api/requests/${id}`);
  setTitle('تفاصيل الطلب');
  const byTask = new Map();
  for (const it of items) {
    if (!byTask.has(it.task_id)) byTask.set(it.task_id, { title: it.task_title, list: [] });
    byTask.get(it.task_id).list.push(it);
  }
  const el = render(`
    <div class="page-head">
      <div class="titles"><a class="crumb" href="#/requests">${icon('back')}الطلبات</a>
        <h1>${q.scope === 'project' ? `متطلبات مشروع «${esc(q.project_name)}»` : `متطلبات المهمة «${esc(q.task_title)}»`}</h1>
        <div class="row wrap" style="gap:.4rem;margin-top:.4rem">${pill(REQUEST_STATUS[q.status])}
          <span class="pill gray plain">${plural(items.length, ITEMS_N)}</span></div></div>
      <div class="actions">
        ${can.respond ? `<button class="btn success" id="approve">${icon('check')}موافقة</button>
          <button class="btn danger" id="reject">${icon('x')}رفض</button>` : ''}
        ${can.forward ? `<button class="btn ghost" id="forward">${icon('forward')}إحالة إلى ${esc(state.me.supervisor_name)}</button>` : ''}
      </div>
    </div>
    <div class="grid side">
      <section class="card">
        <div class="row" style="margin-bottom:1rem">${avatar(q.sender_name, q.sender_id)}<div class="grow">
          <div><strong>${esc(q.sender_name)}</strong> إلى ${esc(q.recipient_name)}</div>
          <div class="muted small">${esc(fmtDateTime(q.created_at))} · <a href="#/projects/${q.project_id}">${esc(q.project_name)}</a></div></div></div>
        ${q.note ? `<div class="callout blue">${icon('report')}<div>${esc(q.note)}</div></div>` : ''}
        ${q.response_note ? `<div class="callout ${q.status === 'rejected' ? 'red' : 'green'}">${icon('reply')}<div><strong>الرد:</strong> ${esc(q.response_note)}</div></div>` : ''}
        ${[...byTask.entries()].map(([taskId, g]) => `<h3 style="margin-top:.8rem"><a href="#/tasks/${taskId}">${icon('tasks')} ${esc(g.title)}</a></h3>
          <div class="list">${g.list.map((it) => `<div class="item">${icon('box')}<div class="grow">${esc(it.description)}</div>
            ${it.quantity ? `<span class="pill gray plain">الكمية: ${esc(it.quantity)}</span>` : ''}</div>`).join('')}</div>`).join('')}
      </section>
      <aside class="card">
        <div class="card-head"><h3>مسار الطلب</h3></div>
        <ul class="timeline">${chain.map((c) => `<li class="${c.status === 'approved' ? 's-done' : c.status === 'rejected' ? 's-blocked' : ''}">
          <div><strong>${esc(c.sender_name)}</strong> ← ${esc(c.recipient_name)}</div>
          <div style="margin:.2rem 0">${pill(REQUEST_STATUS[c.status])}</div>
          ${c.note ? `<div class="small">${esc(c.note)}</div>` : ''}
          <div class="muted small">${esc(fmtDateTime(c.created_at))}</div></li>`).join('')}</ul>
      </aside>
    </div>`);

  const respond = (decision) => openModal({
    title: decision === 'approved' ? 'الموافقة على الطلب' : 'رفض الطلب',
    body: `<div class="field"><label>${decision === 'approved' ? 'ملاحظة <span class="hint">(اختياري)</span>' : 'سبب الرفض <span class="hint">(إلزامي)</span>'}</label>
      <textarea name="note"></textarea></div>`,
    submitLabel: decision === 'approved' ? 'تأكيد الموافقة' : 'تأكيد الرفض',
    danger: decision === 'rejected',
    onSubmit: async (d) => {
      await api('POST', `/api/requests/${q.id}/respond`, { ...d, decision });
      toast(decision === 'approved' ? 'تمت الموافقة على الطلب' : 'تم رفض الطلب');
      viewRequest({ id });
    },
  });
  if (can.respond) {
    $('#approve', el).addEventListener('click', () => respond('approved'));
    $('#reject', el).addEventListener('click', () => respond('rejected'));
  }
  if (can.forward) $('#forward', el).addEventListener('click', () => openModal({
    title: `إحالة الطلب إلى ${state.me.supervisor_name}`,
    body: '<div class="field"><label>ملاحظة <span class="hint">(اختياري)</span></label><textarea name="note"></textarea></div>',
    submitLabel: 'إحالة',
    onSubmit: async (d) => {
      await api('POST', `/api/requests/${q.id}/forward`, d);
      toast('تمت إحالة الطلب');
      viewRequest({ id });
    },
  }));
  setFab(null);
}
