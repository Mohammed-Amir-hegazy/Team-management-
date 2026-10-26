import {
  state, $, $$, esc, icon, api, render, setTitle, setFab, toast, openModal, confirmDialog, attempt, busy,
  STATUS_LABELS, STATUSES, PRIORITY_LABELS, REQUEST_STATUS,
  statusPill, pill, avatar, taskList, tabs, onTabs, remember, deadlineInfo, fmtDateTime, relTime,
  toLocalInput, fromLocalInput, plural, ITEMS_N, formData, managerPicker, isScheduled,
} from '../core.js';
import { composeReport } from './reports.js';
import { gallery, bindGallery, photoUploadModal } from '../uploads.js';
import { openReminder } from '../remind.js';

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export async function taskFormModal({ projectId = null, task = null, assignable = null }) {
  let projects = null;
  if (!task && !projectId) {
    projects = (await api('GET', '/api/projects')).projects.filter((p) => p.status !== 'completed');
  }
  if (!assignable) {
    const { users } = await api('GET', '/api/users');
    assignable = users.filter((u) => u.active && (u.id === state.me.id || u.in_my_team));
  }
  const t = task || { title: '', description: '', priority: 'medium', assignee_id: state.me.id, deadline: null, reminder_at: null };
  const { form } = openModal({
    title: task ? 'تعديل المهمة' : 'مهمة جديدة',
    body: `
      <div class="field"><label>عنوان المهمة</label><input name="title" value="${esc(t.title)}" required placeholder="مثال: تصميم الصفحة الرئيسية"></div>
      ${projects ? `<div class="field"><label>المشروع</label><select name="project_id">
        <option value="">بدون مشروع — مهمة مستقلة</option>
        ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <span class="hint">المهام المستقلة لا تندرج تحت مشروع، ويطّلع عليها مسؤولوك.</span></div>` : ''}
      <div class="field"><label>الوصف <span class="hint">(اختياري)</span></label><textarea name="description" placeholder="تفاصيل المهمة ومخرجاتها المتوقعة">${esc(t.description)}</textarea></div>
      <div class="fields">
        <div class="field"><label>المسؤول عن التنفيذ</label><select name="assignee_id">
          ${assignable.map((u) => `<option value="${u.id}" ${u.id === t.assignee_id ? 'selected' : ''}>${esc(u.id === state.me.id ? `${u.name} (أنا)` : u.name)}${u.job_title ? ` — ${esc(u.job_title)}` : ''}</option>`).join('')}
        </select></div>
        <div class="field"><label>الأولوية</label><select name="priority">
          ${Object.entries(PRIORITY_LABELS).map(([k, l]) => `<option value="${k}" ${k === t.priority ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      </div>
      <div class="fields">
        <div class="field"><label>الموعد النهائي</label><input type="datetime-local" name="deadline" value="${toLocalInput(t.deadline)}"></div>
        <div class="field"><label>موعد التنبيه</label><input type="datetime-local" name="reminder_at" value="${toLocalInput(t.reminder_at)}">
          <div class="chips" style="margin-top:.2rem">
            <button type="button" class="chip" data-before="60">قبل الموعد بساعة</button>
            <button type="button" class="chip" data-before="1440">قبل الموعد بيوم</button>
          </div></div>
      </div>`,
    submitLabel: task ? 'حفظ التعديلات' : 'إنشاء المهمة',
    onSubmit: async (d) => {
      const body = {
        title: d.title,
        description: d.description,
        priority: d.priority,
        assignee_id: Number(d.assignee_id),
        deadline: fromLocalInput(d.deadline),
        reminder_at: fromLocalInput(d.reminder_at),
      };
      if (task) {
        await api('PATCH', `/api/tasks/${task.id}`, body);
        toast('تم حفظ التعديلات');
        window.dispatchEvent(new Event('refresh-view'));
      } else {
        const target = projectId || d.project_id;
        const r = await api('POST', target ? `/api/projects/${target}/tasks` : '/api/tasks', body);
        toast('تم إنشاء المهمة');
        location.hash = `#/tasks/${r.task.id}`;
      }
    },
  });
  $$('[data-before]', form).forEach((b) => b.addEventListener('click', () => {
    const deadline = form.elements.deadline.value;
    if (!deadline) { toast('حدّد الموعد النهائي أولًا', { error: true }); return; }
    const at = new Date(new Date(deadline).getTime() - Number(b.dataset.before) * 60000);
    form.elements.reminder_at.value = toLocalInput(at.toISOString());
  }));
}

export function sendRequirementsModal(path, count, after) {
  openModal({
    title: 'إرسال المتطلبات',
    body: `<div class="callout blue">${icon('send')}<div>سيتم إرسال <strong>${plural(count, ITEMS_N)}</strong> في طلب واحد.</div></div>
      ${managerPicker('إلى')}
      <div class="field"><label>ملاحظة مرفقة <span class="hint">(اختياري)</span></label><textarea name="note" placeholder="مثال: نحتاجها قبل نهاية الأسبوع"></textarea></div>`,
    submitLabel: 'إرسال الآن',
    onSubmit: async (d) => {
      const r = await api('POST', path, { note: d.note, recipient_id: Number(d.recipient_id) || null });
      toast(`تم إرسال ${plural(r.count, ITEMS_N)} بنجاح`);
      after();
    },
  });
}

// ---------------------------------------------------------------------------
// Tasks list
// ---------------------------------------------------------------------------

export async function viewTasks({ query }) {
  setTitle('المهام');
  const me = state.me;
  const scope = me.has_team ? (query.get('scope') || remember('taskScope') || 'mine') : 'mine';
  const status = query.get('status') || '';
  const assignee = query.get('assignee') || '';
  remember('taskScope', scope);

  const qs = new URLSearchParams({ scope });
  if (status) qs.set('status', status);
  if (assignee && scope === 'team') qs.set('assignee', assignee);
  const [{ tasks }, team] = await Promise.all([
    api('GET', `/api/tasks?${qs}`),
    scope === 'team' ? api('GET', '/api/users').then((r) => r.users.filter((u) => u.in_my_team && u.active)) : [],
  ]);

  const go = (changes) => {
    const p = new URLSearchParams({ scope, status, assignee, ...changes });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    location.hash = `#/tasks?${p}`;
  };
  const filters = [['', 'الكل'], ...STATUSES.filter((s) => s !== 'done').map((s) => [s, STATUS_LABELS[s]]), ['overdue', 'متأخرة'], ['done', 'مكتملة']];

  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>المهام</h1><div class="sub">${scope === 'team' ? 'متابعة مهام أعضاء فريقك' : 'المهام المسندة إليك في جميع المشاريع'}</div></div>
      <div class="actions"><button class="btn" id="new-task">${icon('plus')}مهمة جديدة</button></div>
    </div>
    ${me.has_team ? tabs([['mine', 'مهامي'], ['team', 'مهام الفريق']], scope) : ''}
    <div class="toolbar">
      <div class="input-icon">${icon('search')}<input id="q" type="search" placeholder="ابحث بعنوان المهمة أو المشروع"></div>
      ${scope === 'team' ? `<select id="member"><option value="">جميع أعضاء الفريق</option>
        ${team.map((u) => `<option value="${u.id}" ${String(u.id) === assignee ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="chips" style="margin-bottom:1rem">${filters.map(([k, l]) =>
      `<button class="chip ${k === status ? 'active' : ''}" data-status="${k}">${l}</button>`).join('')}</div>
    <div id="list">${taskList(tasks, { showAssignee: scope === 'team', emptyTitle: 'لا توجد مهام مطابقة', emptyText: 'جرّب تغيير عوامل التصفية.' })}</div>`);

  onTabs(el, (tab) => go({ scope: tab, assignee: '' }));
  $$('[data-status]', el).forEach((b) => b.addEventListener('click', () => go({ status: b.dataset.status })));
  const member = $('#member', el);
  if (member) member.addEventListener('change', () => go({ assignee: member.value }));
  $('#q', el).addEventListener('input', (e) => {
    const q = e.target.value.trim();
    $$('.task', el).forEach((card) => { card.classList.toggle('hidden', q && !card.textContent.includes(q)); });
  });
  const add = () => taskFormModal({});
  $('#new-task', el).addEventListener('click', add);
  setFab('مهمة جديدة', add);
}

// ---------------------------------------------------------------------------
// Task page
// ---------------------------------------------------------------------------

export async function viewTask({ id }) {
  const data = await api('GET', `/api/tasks/${id}`);
  const { task: t, history, requirements, permissions: can } = data;
  setTitle('تفاصيل المهمة');
  const me = state.me;
  const drafts = requirements.filter((r) => !r.request_id && r.requested_by === me.id);
  const sent = requirements.filter((r) => r.request_id);
  const dl = deadlineInfo(t.deadline, t.status);
  // The person responsible for a recurring follow-up reports its result (with photos) from here.
  const followUpResult = t.recurring_id && t.assignee_id === me.id && (me.supervisor_id || t.created_by !== me.id);
  const reports = data.reports || [];

  const el = render(`
    <div class="page-head">
      <div class="titles">
        ${data.project.standalone
          ? `<a class="crumb" href="#/tasks">${icon('back')}مهمة مستقلة</a>`
          : `<a class="crumb" href="#/projects/${data.project.id}">${icon('back')}${esc(data.project.name)}</a>`}
        <h1>${esc(t.title)}</h1>
        <div class="row wrap" style="margin-top:.4rem;gap:.4rem">${statusPill(t.status)}
          <span class="pill plain ${t.priority === 'high' ? 'red' : t.priority === 'medium' ? 'amber' : 'gray'}">${icon('flag')} أولوية ${PRIORITY_LABELS[t.priority]}</span>
          ${t.recurring_id ? '<span class="pill blue plain">🔁 متابعة دورية</span>' : ''}
          ${isScheduled(t) ? `<span class="pill amber plain">📅 مجدولة بتاريخ ${esc(fmtDateTime(t.reminder_at))}</span>` : ''}
          ${dl.late ? `<span class="pill red plain">${icon('clock')} متأخرة</span>` : ''}</div>
      </div>
      <div class="actions">
        ${can.remind ? `<button class="btn subtle" id="remind-task">${icon('bell')}تذكير ${esc(t.assignee_name.split(' ')[0])}</button>` : ''}
        ${followUpResult ? `<button class="btn" id="follow-up-result">${icon('send')}إرسال نتيجة المتابعة</button>`
          : me.supervisor_id ? `<button class="btn ghost" id="task-report">${icon('send')}تقرير عن المهمة</button>` : ''}
        ${can.edit ? `<button class="btn ghost" id="edit-task">${icon('edit')}تعديل</button>
          <button class="btn ghost" id="delete-task" aria-label="حذف المهمة">${icon('trash')}</button>` : ''}
      </div>
    </div>

    <div class="grid side">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>حالة المهمة</h2></div>
          ${t.status_note ? `<div class="callout ${t.status === 'blocked' ? 'red' : t.status === 'done' ? 'green' : 'blue'}">
            ${icon(t.status === 'blocked' ? 'alert' : 'report')}<div><strong>${STATUS_LABELS[t.status]}:</strong> ${esc(t.status_note)}</div></div>` : ''}
          ${can.update_status ? `<form id="status-form" novalidate>
            <div class="status-picker" role="radiogroup" aria-label="الحالة">${STATUSES.map((s) =>
              `<button type="button" role="radio" data-s="${s}" class="${s === t.status ? 'on' : ''}" aria-checked="${s === t.status}"><span class="sw"></span>${STATUS_LABELS[s]}</button>`).join('')}</div>
            <input type="hidden" name="status" value="${t.status}">
            <div class="field"><label id="note-label">ملاحظة حول الحالة <span class="hint">(اختياري)</span></label>
              <textarea name="note" placeholder="أين وصل العمل؟ وما الخطوة التالية؟"></textarea></div>
            <div class="form-error" role="alert"></div>
            <button class="btn" type="submit">${icon('check')}تحديث الحالة</button>
          </form>` : '<p class="muted">يمكن للمسؤول عن المهمة أو من يعلوه تحديث حالتها.</p>'}
        </section>

        ${t.recurring_id || reports.length ? `<section class="card">
          <div class="card-head"><h2>${t.recurring_id ? 'نتائج المتابعة' : 'التقارير عن المهمة'}</h2><span class="muted small">${reports.length || ''}</span></div>
          ${reports.length ? `<div class="list">${reports.map((r) => `<a class="item link" href="#/reports/${r.id}">
            ${icon('report')}<div class="grow"><div class="title">${esc(r.title)}</div>
              <div class="meta">${esc(r.sender_name)} ← ${esc(r.recipient_name)} · ${esc(fmtDateTime(r.created_at))}${
                r.image_count ? ` · ${icon('camera')} ${r.image_count}` : ''}</div></div></a>`).join('')}</div>`
            : `<p class="muted" style="margin:0">${followUpResult
              ? 'بعد تنفيذ المتابعة اضغط «إرسال نتيجة المتابعة» واكتب ما وجدته، ويمكنك إرفاق صور.'
              : 'لم تُرسل نتيجة هذه المتابعة بعد.'}</p>`}
        </section>` : ''}

        <section class="card">
          <div class="card-head"><h2>صور داعمة للتنفيذ</h2><span class="muted small">${data.attachments.length || ''}</span>
            <div class="actions">${can.upload && state.config.uploads ? `<button class="btn sm subtle" id="add-photos">${icon('camera')}إضافة صور</button>` : ''}</div></div>
          ${data.attachments.length ? gallery(data.attachments, { deletable: true })
            : `<div class="upload-zone">${can.upload && state.config.uploads
              ? 'أضف صورًا توثّق سير العمل؛ ستُرفق تلقائيًا بتقاريرك عن هذه المهمة.'
              : state.config.uploads ? 'لا توجد صور مرفقة بعد.' : 'رفع الصور غير مفعّل حاليًا.'}</div>`}
        </section>

        <section class="card">
          <div class="card-head"><h2>متطلبات المهمة</h2></div>
          ${can.add_requirements ? `
            <form class="inline-form" id="req-form" novalidate>
              <div class="field" style="flex:3"><label>ما الذي تحتاجه لإنجاز المهمة؟</label><input name="description" placeholder="مثال: صلاحية الدخول إلى الخادم" required></div>
              <div class="field" style="flex:1"><label>الكمية</label><input name="quantity" placeholder="اختياري"></div>
              <button class="btn subtle" type="submit">${icon('plus')}إضافة</button>
            </form>
            ${drafts.length ? `<div class="list" style="margin-top:.6rem">${drafts.map((r) => `<div class="item">
              ${icon('box')}<div class="grow">${esc(r.description)}${r.quantity ? ` <span class="muted">× ${esc(r.quantity)}</span>` : ''}</div>
              ${pill(REQUEST_STATUS.draft)}
              <button class="icon-btn" data-del-req="${r.id}" aria-label="حذف">${icon('trash')}</button></div>`).join('')}</div>` : ''}
            <div class="send-bar" style="margin-top:.8rem">
              <div>${drafts.length ? `<strong>${plural(drafts.length, ITEMS_N)}</strong> جاهزة للإرسال` : 'أضف المتطلبات ثم أرسلها دفعة واحدة'}</div>
              <button class="btn" id="send-task-reqs" ${drafts.length ? '' : 'disabled'}>${icon('send')}إرسال إلى ${esc(me.supervisor_name || '')}</button>
            </div>` : '<p class="muted">لا يوجد مسؤول مباشر أعلى منك لطلب المتطلبات منه.</p>'}
          ${sent.length ? `<h3 style="margin-top:1.1rem">المتطلبات المرسلة</h3>
            <div class="list">${sent.map((r) => `<a class="item link" href="#/requests/${r.request_id}">
              ${icon('box')}<div class="grow"><div>${esc(r.description)}${r.quantity ? ` <span class="muted">× ${esc(r.quantity)}</span>` : ''}</div>
                <div class="meta">${esc(r.requested_by_name)} · ${esc(relTime(r.sent_at))}${r.response_note ? ` · الرد: ${esc(r.response_note)}` : ''}</div></div>
              ${pill(REQUEST_STATUS[r.request_status])}</a>`).join('')}</div>` : ''}
        </section>

        <section class="card">
          <div class="card-head"><h2>سجل الحالات</h2></div>
          <ul class="timeline">${history.map((h) => `<li class="s-${h.to_status}">
            <div class="row wrap" style="gap:.35rem">${h.from_status ? `${statusPill(h.from_status)} ${icon('next')}` : ''}${statusPill(h.to_status)}</div>
            ${h.note ? `<div style="margin-top:.25rem">${esc(h.note)}</div>` : ''}
            <div class="muted small">${esc(h.user_name)} · ${esc(fmtDateTime(h.created_at))}</div></li>`).join('')}</ul>
        </section>
      </div>

      <aside class="stack">
        <section class="card">
          <div class="card-head"><h3>التفاصيل</h3></div>
          <div class="list">
            <div class="item">${avatar(t.assignee_name, t.assignee_id)}<div class="grow"><div class="muted small">المسؤول عن التنفيذ</div><div class="title">${esc(t.assignee_name)}</div></div></div>
            <div class="item">${icon('calendar')}<div class="grow"><div class="muted small">الموعد النهائي</div>
              <div class="${dl.late ? 'late' : ''}">${t.deadline ? esc(fmtDateTime(t.deadline)) : 'غير محدد'}</div>
              ${t.deadline ? `<div class="muted small">${esc(dl.text)}</div>` : ''}</div></div>
            <div class="item">${icon('bell')}<div class="grow"><div class="muted small">التنبيه</div>
              <div>${t.reminder_at ? esc(fmtDateTime(t.reminder_at)) : 'غير مفعّل'} ${t.reminder_at && t.reminder_sent ? '<span class="pill gray plain">أُرسل</span>' : ''}</div></div>
              ${can.set_reminder ? `<button class="btn sm subtle" id="set-reminder">ضبط</button>` : ''}</div>
            <div class="item">${icon('user')}<div class="grow"><div class="muted small">أنشأها</div><div>${esc(t.creator_name)}</div></div></div>
            <div class="item">${icon('folder')}<div class="grow"><div class="muted small">المشروع</div><a href="#/projects/${data.project.id}">${esc(data.project.name)}</a></div></div>
          </div>
        </section>
        ${t.description ? `<section class="card"><div class="card-head"><h3>الوصف</h3></div><div class="pre">${esc(t.description)}</div></section>` : ''}
      </aside>
    </div>`);

  bindGallery(el);
  const addPhotos = $('#add-photos', el);
  if (addPhotos) addPhotos.addEventListener('click', () => photoUploadModal({
    signParams: { purpose: 'task', task_id: t.id },
    onDone: async (images, caption) => {
      await api('POST', `/api/tasks/${t.id}/attachments`, { images, caption });
      toast(images.length === 1 ? 'تمت إضافة الصورة' : `تمت إضافة ${images.length} صور`);
      viewTask({ id });
    },
  }));
  $$('[data-del-img]', el).forEach((b) => b.addEventListener('click', () => confirmDialog('هل تريد حذف هذه الصورة؟', async () => {
    await api('DELETE', `/api/attachments/${b.dataset.delImg}`);
    toast('تم حذف الصورة');
    viewTask({ id });
  }, 'حذف')));
  const remind = $('#remind-task', el);
  if (remind) remind.addEventListener('click', () => openReminder({
    person: { id: t.assignee_id, name: t.assignee_name, phone: t.assignee_phone, job_title: t.assignee_job_title },
    relation: 'down',
    task: t,
  }));

  const report = $('#task-report', el);
  if (report) report.addEventListener('click', () => composeReport({ task_id: t.id, label: `المهمة: ${t.title}` }));
  const result = $('#follow-up-result', el);
  if (result) result.addEventListener('click', () => composeReport({
    task_id: t.id,
    label: `المتابعة: ${t.title}`,
    title: `نتيجة المتابعة: ${t.title}`,
    followUp: { owner: { id: t.created_by, name: t.creator_name }, can_complete: can.update_status && t.status !== 'done' },
  }));
  if (can.edit) {
    $('#edit-task', el).addEventListener('click', () => taskFormModal({ task: t, assignable: data.assignable_users }));
    $('#delete-task', el).addEventListener('click', () => confirmDialog('سيتم حذف المهمة وسجلها ومتطلباتها نهائيًا. هل تريد المتابعة؟', async () => {
      await api('DELETE', `/api/tasks/${t.id}`);
      toast('تم حذف المهمة');
      location.hash = `#/projects/${data.project.id}`;
    }, 'حذف المهمة'));
  }

  const reminderBtn = $('#set-reminder', el);
  if (reminderBtn) {
    reminderBtn.addEventListener('click', () => openModal({
      title: 'ضبط التنبيه',
      body: `<div class="field"><label>نبّهني في</label><input type="datetime-local" name="reminder_at" value="${toLocalInput(t.reminder_at)}"></div>
        <p class="muted small">اترك الحقل فارغًا لإلغاء التنبيه. يظهر التنبيه بصوت ورسالة أثناء استخدامك للمنصة.</p>`,
      onSubmit: async (d) => {
        await api('PATCH', `/api/tasks/${t.id}`, { reminder_at: fromLocalInput(d.reminder_at) });
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        toast(d.reminder_at ? 'تم ضبط التنبيه' : 'تم إلغاء التنبيه');
        viewTask({ id });
      },
    }));
  }

  const statusForm = $('#status-form', el);
  if (statusForm) {
    const label = $('#note-label', el);
    const sync = (s) => {
      statusForm.elements.status.value = s;
      $$('.status-picker button', statusForm).forEach((b) => {
        b.classList.toggle('on', b.dataset.s === s);
        b.setAttribute('aria-checked', b.dataset.s === s);
      });
      label.innerHTML = s === 'blocked'
        ? 'سبب التوقف <span class="hint">(إلزامي)</span>'
        : 'ملاحظة حول الحالة <span class="hint">(اختياري)</span>';
    };
    $$('.status-picker button', statusForm).forEach((b) => b.addEventListener('click', () => sync(b.dataset.s)));
    statusForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', statusForm);
      busy(btn, async () => {
        try {
          await api('POST', `/api/tasks/${t.id}/status`, formData(statusForm));
        } catch (err) {
          $('.form-error', statusForm).textContent = err.message;
          return;
        }
        toast('تم تحديث حالة المهمة');
        await viewTask({ id });
        const p = $('.page-head .pill');
        if (p) p.classList.add('pop');
      });
    });
  }

  const reqForm = $('#req-form', el);
  if (reqForm) {
    reqForm.addEventListener('submit', (e) => {
      e.preventDefault();
      attempt(async () => {
        await api('POST', `/api/tasks/${t.id}/requirements`, formData(reqForm));
        await viewTask({ id });
        const input = $('#req-form input[name=description]');
        if (input) input.focus();
      });
    });
    $$('[data-del-req]', el).forEach((b) => b.addEventListener('click', () => attempt(async () => {
      await api('DELETE', `/api/requirements/${b.dataset.delReq}`);
      viewTask({ id });
    })));
    $('#send-task-reqs', el).addEventListener('click', () => sendRequirementsModal(
      `/api/tasks/${t.id}/requirements/send`, drafts.length, () => viewTask({ id })));
  }
  setFab(null);
}
