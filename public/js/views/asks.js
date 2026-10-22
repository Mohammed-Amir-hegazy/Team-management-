// Requests to a manager above or to any colleague: the person asked takes it on as a task of their own
// or declines it with a reason (a manager may also approve it), and the sender follows what happens.

import {
  state, $, $$, esc, icon, api, render, setTitle, setFab, toast, openModal, confirmDialog, avatar, pill,
  fmtDateTime, statusPill, PRIORITY_LABELS, toLocalInput, fromLocalInput, rememberPhotos, relTime,
} from '../core.js';

// A request's state, worded for its kind.
export function askStatus(q) {
  if (q.status === 'accepted') return q.task_id || q.kind !== 'manager' ? ['أُضيف كمهمة', 'green'] : ['تمت الموافقة', 'green'];
  if (q.status === 'declined') return q.kind === 'manager' ? ['مرفوض', 'red'] : ['اعتذر عنه', 'red'];
  return { pending: ['بانتظار الرد', 'amber'], cancelled: ['أُلغي', 'gray'] }[q.status];
}

const KIND_LABEL = { manager: 'إلى مسؤول', colleague: 'إلى زميل' };

// "Send a request": first to whom (a manager above me or a colleague), then what is needed.
export async function newRequestModal({ kind = null, recipientId = null } = {}) {
  const chain = state.me.chain || [];
  const { colleagues } = await api('GET', '/api/colleagues');
  rememberPhotos(colleagues);
  const managerIds = new Set(chain.map((m) => m.id));
  const choose = kind || (recipientId ? (managerIds.has(recipientId) ? 'manager' : 'colleague') : null);
  const person = (c, checked) => `<label class="check" data-name="${esc(`${c.name} ${c.job_title || ''}`)}">
    <input type="radio" name="recipient_id" value="${c.id}" ${checked ? 'checked' : ''}>
    ${avatar(c.name, c.id, 'sm')}<span class="grow">${esc(c.name)}<small>${esc(c.job_title || '')}</small></span></label>`;

  const { el, form } = openModal({
    title: 'إرسال طلب',
    wide: true,
    body: `
      <div class="field"><label>الطلب موجّه إلى</label><div class="checks cols kind-pick">
        <label class="check"><input type="radio" name="kind" value="manager" ${choose === 'manager' ? 'checked' : ''} ${chain.length ? '' : 'disabled'}>
          ${icon('shield')}<span class="grow">مسؤول أعلى<small>${chain.length ? 'مسؤولك المباشر أو أي مسؤول فوقه' : 'لا يوجد مسؤول أعلى منك'}</small></span></label>
        <label class="check"><input type="radio" name="kind" value="colleague" ${choose === 'colleague' ? 'checked' : ''}>
          ${icon('users')}<span class="grow">زميل<small>أي شخص في الشركة</small></span></label>
      </div></div>
      <div id="ask-rest" class="${choose ? '' : 'hidden'}">
        <div class="field" data-for="manager"><label>المسؤول</label><div class="checks scroll ask-people">
          ${chain.map((m, i) => person({ ...m, job_title: `${m.job_title || ''}${i === 0 ? ' (المسؤول المباشر)' : ''}` },
    recipientId ? m.id === recipientId : i === 0)).join('')}</div></div>
        <div class="field" data-for="colleague"><label>الزميل</label>
          <div class="input-icon">${icon('search')}<input type="search" id="who-q" placeholder="ابحث بالاسم أو المسمى الوظيفي"></div>
          <div class="checks scroll ask-people" id="who">${colleagues.filter((c) => !managerIds.has(c.id) || recipientId === c.id)
    .map((c) => person(c, c.id === recipientId)).join('')}</div></div>
        <div class="field"><label>المطلوب</label><input name="title" required maxlength="300" placeholder="مثال: اعتماد ميزانية حملة الإطلاق"></div>
        <div class="field"><label>التفاصيل <span class="hint">(اختياري)</span></label><textarea name="details" rows="4" maxlength="10000"></textarea></div>
        <div class="fields">
          <div class="field"><label>الأولوية</label><select name="priority">
            ${['medium', 'high', 'low'].map((p) => `<option value="${p}">${PRIORITY_LABELS[p]}</option>`).join('')}</select></div>
          <div class="field"><label>مطلوب قبل <span class="hint">(اختياري)</span></label><input type="datetime-local" name="due_at"></div>
        </div>
      </div>`,
    submitLabel: 'إرسال الطلب',
    onSubmit: async () => {
      const d = {};
      for (const f of form.elements) if (f.name && (f.type !== 'radio' || f.checked) && !f.closest('.hidden')) d[f.name] = f.value;
      if (!d.kind) throw new Error('يُرجى اختيار: إلى مسؤول أم إلى زميل');
      if (!d.recipient_id) throw new Error(d.kind === 'manager' ? 'يُرجى اختيار المسؤول' : 'يُرجى اختيار الزميل');
      const { request } = await api('POST', '/api/work-requests', {
        kind: d.kind, recipient_id: Number(d.recipient_id), title: d.title, details: d.details, priority: d.priority, due_at: fromLocalInput(d.due_at),
      });
      toast(`تم إرسال الطلب إلى ${request.recipient_name}`);
      location.hash = `#/asks/${request.id}`;
    },
  });
  const sync = () => {
    const k = $('[name=kind]:checked', el)?.value;
    $('#ask-rest', el).classList.toggle('hidden', !k);
    $$('[data-for]', el).forEach((f) => f.classList.toggle('hidden', f.dataset.for !== k));
  };
  $$('[name=kind]', el).forEach((r) => r.addEventListener('change', () => {
    // Switching the kind clears a person chosen in the other list.
    $$('[name=recipient_id]', el).forEach((x) => { if (x.closest('[data-for]').dataset.for !== r.value) x.checked = false; });
    sync();
  }));
  sync();
  $('#who-q', el).addEventListener('input', (e) => {
    const q = e.target.value.trim();
    $$('#who .check', el).forEach((c) => c.classList.toggle('hidden', !!q && !c.dataset.name.includes(q)));
  });
  return form;
}

export function askRow(q, box, i) {
  const person = box === 'sent' ? { name: q.recipient_name, id: q.recipient_id } : { name: q.sender_name, id: q.sender_id };
  return `<div class="item link" data-href="#/asks/${q.id}" style="--i:${Math.min(i, 12)}">
    ${avatar(person.name, person.id)}
    <div class="grow">
      <div class="title">${esc(q.title)}</div>
      <div class="meta"><span class="pill gray plain">${KIND_LABEL[q.kind] || KIND_LABEL.colleague}</span>
        ${box === 'sent' ? `إلى ${esc(q.recipient_name)}` : `من ${esc(q.sender_name)}`} · ${esc(relTime(q.created_at))}
        ${q.due_at ? ` · مطلوب قبل ${esc(fmtDateTime(q.due_at))}` : ''}</div>
    </div>
    ${q.status === 'accepted' && q.task_status ? statusPill(q.task_status) : pill(askStatus(q))}
  </div>`;
}

// Requests now live on the single «الطلبات» page; only a request's own page is here.
export async function viewAsks({ id }) {
  if (id) return viewAsk(id);
  location.hash = '#/requests';
  return undefined;
}

async function viewAsk(id) {
  const { request: q, permissions: can } = await api('GET', `/api/work-requests/${id}`);
  setTitle('تفاصيل الطلب');
  const mine = q.sender_id === state.me.id;
  const el = render(`
    <div class="page-head">
      <div class="titles"><a class="crumb" href="#/requests?box=${mine ? 'sent' : 'inbox'}">${icon('back')}الطلبات</a>
        <h1>${esc(q.title)}</h1>
        <div class="row wrap" style="gap:.4rem;margin-top:.4rem">${pill(askStatus(q))}
          <span class="pill gray plain">${KIND_LABEL[q.kind] || KIND_LABEL.colleague}</span>
          <span class="pill gray plain">الأولوية: ${PRIORITY_LABELS[q.priority]}</span></div></div>
      <div class="actions">
        ${can.approve ? `<button class="btn success" id="approve">${icon('check')}موافقة</button>` : ''}
        ${can.respond ? `<button class="btn ${can.approve ? 'subtle' : 'success'}" id="accept">${icon('plus')}إضافة كمهمة لدي</button>
          <button class="btn ghost danger-text" id="decline">${icon('x')}${q.kind === 'manager' ? 'رفض' : 'اعتذار'}</button>` : ''}
        ${can.cancel ? `<button class="btn ghost danger-text" id="cancel">${icon('x')}إلغاء الطلب</button>` : ''}
      </div>
    </div>
    <div class="grid side">
      <section class="card stack">
        <div class="row">${avatar(q.sender_name, q.sender_id)}
          <div class="grow"><div class="muted small">من</div><strong>${esc(q.sender_name)}</strong>
            <div class="muted small">${esc(q.sender_job_title || '')}</div></div>
          ${icon('back')}
          ${avatar(q.recipient_name, q.recipient_id)}
          <div class="grow"><div class="muted small">إلى</div><strong>${esc(q.recipient_name)}</strong>
            <div class="muted small">${esc(q.recipient_job_title || '')}</div></div></div>
        <div><h3>التفاصيل</h3><div class="pre">${q.details ? esc(q.details) : '<span class="muted">لا توجد تفاصيل إضافية.</span>'}</div></div>
        ${q.status === 'declined' ? `<div class="callout red">${icon('alert')}<div><strong>${q.kind === 'manager' ? 'سبب الرفض' : 'سبب الاعتذار'}</strong>
          <div class="pre">${esc(q.response_note)}</div></div></div>` : ''}
        ${q.status === 'accepted' && !q.task_id && q.kind === 'manager' ? `<div class="callout green">${icon('check')}<div><strong>${esc(q.recipient_name)}: تمت الموافقة</strong>
          ${q.response_note ? `<div class="pre">${esc(q.response_note)}</div>` : ''}</div></div>` : ''}
        ${q.status === 'accepted' && (q.task_id || q.kind !== 'manager') ? (q.task_id ? `<a class="callout green" href="#/tasks/${q.task_id}">${icon('check')}<div class="grow">
            <strong>أُضيف إلى مهام ${esc(q.recipient_name)}</strong><div>«${esc(q.task_title)}» — الحالة الآن: ${statusPill(q.task_status)}</div></div>${icon('next')}</a>`
    : `<div class="callout amber">${icon('alert')}<div>أُضيف هذا الطلب كمهمة ثم حُذفت المهمة.</div></div>`) : ''}
      </section>
      <section class="card stack">
        <div class="item">${icon('calendar')}<span class="grow">أُرسل في</span><span class="muted">${esc(fmtDateTime(q.created_at))}</span></div>
        <div class="item">${icon('flag')}<span class="grow">مطلوب قبل</span><span class="muted">${q.due_at ? esc(fmtDateTime(q.due_at)) : '—'}</span></div>
        ${q.responded_at ? `<div class="item">${icon('reply')}<span class="grow">تاريخ الرد</span><span class="muted">${esc(fmtDateTime(q.responded_at))}</span></div>` : ''}
      </section>
    </div>`);
  setFab(null);

  if (can.respond) {
    $('#accept', el).addEventListener('click', async () => {
      const { projects } = await api('GET', '/api/projects');
      openModal({
        title: 'إضافة الطلب إلى مهامي',
        wide: true,
        body: `
          <div class="field"><label>عنوان المهمة</label><input name="title" required maxlength="300" value="${esc(q.title)}"></div>
          <div class="field"><label>الوصف</label><textarea name="description" rows="4">${esc(q.details || '')}</textarea></div>
          <div class="fields">
            <div class="field"><label>المشروع</label><select name="project_id">
              <option value="">مهمة مستقلة (بدون مشروع)</option>
              ${projects.filter((p) => p.status !== 'completed').map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
            <div class="field"><label>الأولوية</label><select name="priority">
              ${['high', 'medium', 'low'].map((p) => `<option value="${p}" ${p === q.priority ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>الموعد النهائي</label><input type="datetime-local" name="deadline" value="${toLocalInput(q.due_at)}"></div>
          <p class="muted small">سيُبلَّغ ${esc(q.sender_name)} بقبول الطلب، ويتابع حالة المهمة حتى اكتمالها.</p>`,
        submitLabel: 'إضافة إلى مهامي',
        onSubmit: async (d) => {
          const { task } = await api('POST', `/api/work-requests/${q.id}/accept`, {
            title: d.title, description: d.description, priority: d.priority,
            project_id: d.project_id ? Number(d.project_id) : null, deadline: fromLocalInput(d.deadline),
          });
          toast('أُضيف الطلب إلى مهامك');
          location.hash = `#/tasks/${task.id}`;
        },
      });
    });
    const reject = q.kind === 'manager';
    $('#decline', el).addEventListener('click', () => openModal({
      title: reject ? 'رفض الطلب' : 'الاعتذار عن الطلب',
      body: `<div class="field"><label>السبب</label><textarea name="note" rows="3" required
        placeholder="${reject ? 'مثال: الميزانية غير متاحة حاليًا؛ يُعاد الطلب في الربع القادم' : 'مثال: لديّ مهام عاجلة هذا الأسبوع؛ يمكن التواصل مع …'}"></textarea></div>`,
      submitLabel: reject ? 'رفض الطلب' : 'إرسال الاعتذار',
      danger: true,
      onSubmit: async (d) => {
        await api('POST', `/api/work-requests/${q.id}/decline`, { note: d.note });
        toast(`تم إبلاغ ${q.sender_name} ${reject ? 'بالرفض' : 'بالاعتذار'}`);
        window.dispatchEvent(new Event('refresh-view'));
      },
    }));
  }
  if (can.approve) {
    $('#approve', el).addEventListener('click', () => openModal({
      title: 'الموافقة على الطلب',
      body: '<div class="field"><label>ملاحظة <span class="hint">(اختياري)</span></label><textarea name="note" rows="3" placeholder="مثال: تمت الموافقة، ويُنفَّذ خلال الأسبوع"></textarea></div>',
      submitLabel: 'موافقة',
      onSubmit: async (d) => {
        await api('POST', `/api/work-requests/${q.id}/approve`, { note: d.note });
        toast(`تم إبلاغ ${q.sender_name} بالموافقة`);
        window.dispatchEvent(new Event('refresh-view'));
      },
    }));
  }
  if (can.cancel) {
    $('#cancel', el).addEventListener('click', () => confirmDialog('هل تريد إلغاء هذا الطلب؟', async () => {
      await api('POST', `/api/work-requests/${q.id}/cancel`);
      toast('تم إلغاء الطلب');
      window.dispatchEvent(new Event('refresh-view'));
    }, 'إلغاء الطلب'));
  }
}
