// Requests between colleagues: ask anyone in the company for something; the person asked takes it on
// as a task of their own or declines it with a reason, and the one who asked follows the task.

import {
  state, $, $$, esc, icon, api, render, setTitle, setFab, toast, openModal, confirmDialog, avatar, pill, tabs, onTabs,
  remember, relTime, fmtDateTime, emptyState, statusPill, PRIORITY_LABELS, toLocalInput, fromLocalInput, rememberPhotos,
} from '../core.js';

export const ASK_STATUS = {
  pending: ['بانتظار الرد', 'amber'], accepted: ['أُضيف كمهمة', 'green'], declined: ['اعتذر عنه', 'red'], cancelled: ['أُلغي', 'gray'],
};

// Choose a colleague (searchable), then write what is needed.
export async function newAskModal(preselected = null) {
  const { colleagues } = await api('GET', '/api/colleagues');
  rememberPhotos(colleagues);
  if (!colleagues.length) {
    toast('لا يوجد زملاء آخرون في الشركة بعد', { error: true });
    return;
  }
  const { el, form } = openModal({
    title: 'طلب جديد من زميل',
    wide: true,
    body: `
      <div class="field"><label>إلى</label>
        <div class="input-icon">${icon('search')}<input type="search" id="who-q" placeholder="ابحث بالاسم أو المسمى الوظيفي"></div>
        <div class="checks scroll ask-people" id="who">${colleagues.map((c) => `<label class="check" data-name="${esc(`${c.name} ${c.job_title || ''}`)}">
          <input type="radio" name="recipient_id" value="${c.id}" ${c.id === preselected ? 'checked' : ''}>
          ${avatar(c.name, c.id, 'sm')}<span class="grow">${esc(c.name)}<small>${esc(c.job_title || '')}</small></span></label>`).join('')}</div></div>
      <div class="field"><label>المطلوب</label><input name="title" required maxlength="300" placeholder="مثال: تصميم بانر حملة الإطلاق"></div>
      <div class="field"><label>التفاصيل <span class="hint">(اختياري)</span></label><textarea name="details" rows="4" maxlength="10000"></textarea></div>
      <div class="fields">
        <div class="field"><label>الأولوية</label><select name="priority">
          ${['medium', 'high', 'low'].map((p) => `<option value="${p}">${PRIORITY_LABELS[p]}</option>`).join('')}</select></div>
        <div class="field"><label>مطلوب قبل <span class="hint">(اختياري)</span></label><input type="datetime-local" name="due_at"></div>
      </div>`,
    submitLabel: 'إرسال الطلب',
    onSubmit: async (d) => {
      if (!d.recipient_id) throw new Error('يُرجى اختيار الزميل المطلوب');
      const { request } = await api('POST', '/api/work-requests', {
        recipient_id: Number(d.recipient_id), title: d.title, details: d.details, priority: d.priority, due_at: fromLocalInput(d.due_at),
      });
      toast(`تم إرسال الطلب إلى ${request.recipient_name}`);
      location.hash = `#/asks/${request.id}`;
    },
  });
  $('#who-q', el).addEventListener('input', (e) => {
    const q = e.target.value.trim();
    $$('#who .check', el).forEach((c) => c.classList.toggle('hidden', !!q && !c.dataset.name.includes(q)));
  });
  const chosen = $('#who input:checked', el);
  if (chosen) chosen.closest('.check').scrollIntoView({ block: 'nearest' });
  else $('#who-q', el).focus();
  return form;
}

function askRow(q, box, i) {
  const person = box === 'sent' ? { name: q.recipient_name, id: q.recipient_id } : { name: q.sender_name, id: q.sender_id };
  return `<div class="item link" data-href="#/asks/${q.id}" style="--i:${Math.min(i, 12)}">
    ${avatar(person.name, person.id)}
    <div class="grow">
      <div class="title">${esc(q.title)}</div>
      <div class="meta">${box === 'sent' ? `إلى ${esc(q.recipient_name)}` : `من ${esc(q.sender_name)}`} · ${esc(relTime(q.created_at))}
        ${q.due_at ? ` · مطلوب قبل ${esc(fmtDateTime(q.due_at))}` : ''}</div>
    </div>
    ${q.status === 'accepted' && q.task_status ? statusPill(q.task_status) : pill(ASK_STATUS[q.status])}
  </div>`;
}

export async function viewAsks({ id, query }) {
  if (id) return viewAsk(id);
  setTitle('طلبات الزملاء');
  const boxes = [['inbox', 'الوارد إليّ'], ['sent', 'المرسل مني']];
  let box = query.get('box') || remember('askBox') || 'inbox';
  if (!boxes.some(([k]) => k === box)) box = 'inbox';
  remember('askBox', box);
  const { requests } = await api('GET', `/api/work-requests?box=${box}`);
  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>طلبات الزملاء</h1>
        <div class="sub">اطلب من أي زميل في الشركة، ويضيف طلبك إلى مهامه بضغطة زر</div></div>
      <div class="actions"><button class="btn" id="new-ask">${icon('send')}طلب جديد</button></div>
    </div>
    ${tabs(boxes, box)}
    <section class="card">
      ${requests.length ? `<div class="list stagger">${requests.map((q, i) => askRow(q, box, i)).join('')}</div>`
    : emptyState(box === 'inbox' ? 'لا توجد طلبات واردة' : 'لم ترسل طلبات بعد', box === 'sent' ? 'اطلب من أي زميل ما تحتاجه، وتابع تنفيذه من هنا.' : '')}
    </section>`);
  onTabs(el, (tab) => { location.hash = `#/asks?box=${tab}`; });
  $('#new-ask', el).addEventListener('click', () => newAskModal());
  setFab('طلب جديد', () => newAskModal());
}

async function viewAsk(id) {
  const { request: q, permissions: can } = await api('GET', `/api/work-requests/${id}`);
  setTitle('تفاصيل الطلب');
  const mine = q.sender_id === state.me.id;
  const el = render(`
    <div class="page-head">
      <div class="titles"><a class="crumb" href="#/asks?box=${mine ? 'sent' : 'inbox'}">${icon('back')}طلبات الزملاء</a>
        <h1>${esc(q.title)}</h1>
        <div class="row wrap" style="gap:.4rem;margin-top:.4rem">${pill(ASK_STATUS[q.status])}
          <span class="pill gray plain">الأولوية: ${PRIORITY_LABELS[q.priority]}</span></div></div>
      <div class="actions">
        ${can.respond ? `<button class="btn success" id="accept">${icon('plus')}إضافة كمهمة لدي</button>
          <button class="btn ghost danger-text" id="decline">${icon('x')}اعتذار</button>` : ''}
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
        ${q.status === 'declined' ? `<div class="callout red">${icon('alert')}<div><strong>سبب الاعتذار</strong><div class="pre">${esc(q.response_note)}</div></div></div>` : ''}
        ${q.status === 'accepted' ? (q.task_id ? `<a class="callout green" href="#/tasks/${q.task_id}">${icon('check')}<div class="grow">
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
    $('#decline', el).addEventListener('click', () => openModal({
      title: 'الاعتذار عن الطلب',
      body: `<div class="field"><label>السبب</label><textarea name="note" rows="3" required
        placeholder="مثال: لديّ مهام عاجلة هذا الأسبوع؛ يمكن التواصل مع …"></textarea></div>`,
      submitLabel: 'إرسال الاعتذار',
      danger: true,
      onSubmit: async (d) => {
        await api('POST', `/api/work-requests/${q.id}/decline`, { note: d.note });
        toast(`تم إبلاغ ${q.sender_name} بالاعتذار`);
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
