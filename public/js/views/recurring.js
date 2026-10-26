// Recurring follow-ups on a project page: list, add, edit, pause and remove. Each follow-up becomes a
// task for the person responsible on every due date.

import {
  state, $, $$, esc, icon, api, toast, openModal, confirmDialog, avatar, fmtDateTime, statusPill,
  PRIORITY_LABELS, toLocalInput, fromLocalInput,
} from '../core.js';

const UNIT_LABELS = { day: 'يوم', week: 'أسبوع', month: 'شهر' };

// The next occurrence is already a scheduled task waiting for its date.
const upcoming = (r) => r.active && r.last_task_id && r.last_task_status === 'todo' && r.last_task_at && new Date(r.last_task_at) > new Date();

function tomorrowNine() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

async function scheduleModal(project, current, onSaved) {
  const { users } = await api('GET', '/api/users');
  const people = users.filter((u) => u.active && (u.id === state.me.id || u.in_my_team));
  const r = current || {
    title: `متابعة دورية — ${project.name}`, description: '', assignee_id: state.me.id, every_n: 1, unit: 'week',
    duration_days: 1, priority: 'medium', next_run_at: tomorrowNine(),
  };
  openModal({
    title: current ? 'تعديل المتابعة الدورية' : 'متابعة دورية جديدة',
    wide: true,
    body: `
      <p class="muted small" style="margin-top:0">تظهر كل متابعة قادمة مهمةً مجدولة عند المسؤول عنها قبل موعدها، مع تنبيه في الموعد، ويرسل نتيجتها في تقرير يمكن أن يتضمن صورًا.</p>
      <div class="field"><label>عنوان المتابعة</label><input name="title" required maxlength="300" value="${esc(r.title)}"></div>
      <div class="fields">
        <div class="field"><label>المسؤول عن المتابعة</label><select name="assignee_id">
          ${people.map((u) => `<option value="${u.id}" ${u.id === r.assignee_id ? 'selected' : ''}>${esc(u.id === state.me.id ? `${u.name} (أنا)` : u.name)}${u.job_title ? ` — ${esc(u.job_title)}` : ''}</option>`).join('')}
          ${people.some((u) => u.id === r.assignee_id) ? '' : `<option value="${r.assignee_id}" selected>${esc(r.assignee_name || '')}</option>`}</select></div>
        <div class="field"><label>التكرار</label><div class="repeat-row"><span>كل</span>
          <input name="every_n" type="number" min="1" max="365" required value="${r.every_n}">
          <select name="unit">${Object.entries(UNIT_LABELS).map(([k, l]) => `<option value="${k}" ${k === r.unit ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      </div>
      <div class="fields">
        <div class="field"><label>${current ? 'موعد المتابعة القادمة' : 'موعد أول متابعة'}</label>
          <input name="next_run_at" type="datetime-local" required value="${toLocalInput(r.next_run_at)}"></div>
        <div class="field"><label>مدة التنفيذ (بالأيام)</label><input name="duration_days" type="number" min="0" max="90" value="${r.duration_days}">
          <span class="hint">الموعد النهائي لكل مهمة بعد موعد المتابعة بهذه المدة.</span></div>
      </div>
      <div class="fields">
        <div class="field"><label>الأولوية</label><select name="priority">
          ${['high', 'medium', 'low'].map((p) => `<option value="${p}" ${p === r.priority ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>ما المطلوب في كل متابعة؟ <span class="hint">(اختياري)</span></label>
        <textarea name="description" rows="3" placeholder="مثال: مراجعة نسخ الاحتياط، وحالة الموقع، والرد على ملاحظات العميل">${esc(r.description || '')}</textarea></div>`,
    submitLabel: current ? 'حفظ' : 'إضافة المتابعة',
    onSubmit: async (d) => {
      const body = {
        title: d.title, description: d.description, priority: d.priority, assignee_id: Number(d.assignee_id),
        every_n: Number(d.every_n), unit: d.unit, duration_days: Number(d.duration_days || 0), next_run_at: fromLocalInput(d.next_run_at),
      };
      if (current) await api('PATCH', `/api/recurring/${current.id}`, body);
      else await api('POST', `/api/projects/${project.id}/recurring`, body);
      toast(current ? 'تم حفظ المتابعة' : 'تمت إضافة المتابعة الدورية');
      onSaved();
    },
  });
}

// Fills the "المتابعات الدورية" card of a project page.
export async function recurringSection(box, project, canManage) {
  const draw = async () => {
    let list;
    try {
      ({ recurring: list } = await api('GET', `/api/projects/${project.id}/recurring`));
    } catch {
      box.innerHTML = '';
      return;
    }
    const canEdit = (r) => canManage || r.created_by === state.me.id || (r.assignee_id !== state.me.id && state.me.has_team);
    box.innerHTML = `
      <div class="card-head"><h2>المتابعات الدورية</h2>
        <div class="actions"><button class="btn sm subtle" data-add-recurring>${icon('plus')}متابعة دورية</button></div></div>
      ${list.length ? `<div class="list">${list.map((r) => `<div class="item recurring ${r.active ? '' : 'paused'}">
        ${avatar(r.assignee_name, r.assignee_id, 'sm')}
        <div class="grow">
          <div class="title">🔁 ${esc(r.title)}</div>
          <div class="meta">${esc(r.assignee_name)} · ${esc(r.every_label)}
            · ${!r.active ? '<span class="pill gray plain">متوقفة</span>'
              : upcoming(r) ? `مجدولة: <a href="#/tasks/${r.last_task_id}">${esc(fmtDateTime(r.last_task_at))}</a>`
                : `القادمة: ${esc(fmtDateTime(r.next_run_at))}`}
            ${r.last_task_id && !upcoming(r) ? ` · <a href="#/tasks/${r.last_task_id}">آخر مهمة</a> ${r.last_task_status ? statusPill(r.last_task_status) : ''}` : ''}
            ${r.last_report_id ? ` · <a href="#/reports/${r.last_report_id}">آخر نتيجة</a>` : ''}</div>
        </div>
        ${canEdit(r) ? `<div class="row" style="gap:.25rem">
          <button class="icon-btn" data-toggle="${r.id}" aria-label="${r.active ? 'إيقاف مؤقت' : 'استئناف'}" title="${r.active ? 'إيقاف مؤقت' : 'استئناف'}">${icon(r.active ? 'clock' : 'check')}</button>
          <button class="icon-btn" data-edit-recurring="${r.id}" aria-label="تعديل">${icon('edit')}</button>
          <button class="icon-btn" data-del-recurring="${r.id}" aria-label="حذف">${icon('trash')}</button></div>` : ''}
      </div>`).join('')}</div>`
    : `<p class="muted" style="margin:0">للمشاريع التي تحتاج متابعة كل فترة: حدّد المسؤول والتكرار، فتظهر له المتابعة القادمة مهمةً مجدولة، ويرسل نتيجتها في تقرير بالصور.</p>`}`;
    $('[data-add-recurring]', box).addEventListener('click', () => scheduleModal(project, null, draw));
    const byId = new Map(list.map((r) => [r.id, r]));
    $$('[data-edit-recurring]', box).forEach((b) => b.addEventListener('click', () => scheduleModal(project, byId.get(Number(b.dataset.editRecurring)), draw)));
    $$('[data-toggle]', box).forEach((b) => b.addEventListener('click', async () => {
      const r = byId.get(Number(b.dataset.toggle));
      try {
        await api('PATCH', `/api/recurring/${r.id}`, { active: !r.active });
        toast(r.active ? 'أُوقفت المتابعة مؤقتًا' : 'استُؤنفت المتابعة');
        draw();
      } catch (err) {
        toast(err.message, { error: true });
      }
    }));
    $$('[data-del-recurring]', box).forEach((b) => b.addEventListener('click', () => confirmDialog(
      'حذف هذه المتابعة الدورية؟ لن تُنشأ مهام جديدة منها، وتبقى المهام السابقة كما هي.',
      async () => {
        await api('DELETE', `/api/recurring/${b.dataset.delRecurring}`);
        toast('تم حذف المتابعة');
        draw();
      },
      'حذف',
    )));
  };
  await draw();
}
