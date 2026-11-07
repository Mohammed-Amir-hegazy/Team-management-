// Reminder composer: about a task (to someone in my team), a pending request (to someone above me),
// or a general note. Sent as an in-app alert and/or a WhatsApp message worded for the recipient.

import {
  $, $$, esc, icon, api, toast, openModal, avatar, busy, isToday, rememberPhotos, STATUS_LABELS, ROLE_LABELS, plural, TASKS_N,
} from './core.js';
import {
  launchWhatsApp, waPreview, taskReminderMessage, requestReminderMessage, generalMessage, openWhatsApp, todayTasksMessage,
} from './whatsapp.js';

// Everyone in my team reminded of all their work for today at once: one alert each (it rings in the
// app and on their phone), and WhatsApp per person when wanted.
export async function remindTodayModal() {
  const [{ tasks }, { users }] = await Promise.all([api('GET', '/api/tasks?scope=team'), api('GET', '/api/users')]);
  rememberPhotos(users);
  const byId = new Map(users.map((u) => [u.id, u]));
  const groups = new Map();
  for (const t of tasks.filter(isToday)) {
    if (!groups.has(t.assignee_id)) groups.set(t.assignee_id, []);
    groups.get(t.assignee_id).push(t);
  }
  const people = [...groups].map(([id, list]) => ({ person: byId.get(id) || { id, name: list[0].assignee_name }, tasks: list }))
    .sort((a, b) => b.tasks.length - a.tasks.length);
  if (!people.length) {
    toast('لا توجد مهام لليوم لدى فريقك');
    return;
  }
  const { el, close } = openModal({
    title: 'تذكير الفريق بمهام اليوم',
    wide: true,
    body: `
      <p class="muted small" style="margin-top:0">يصل كل شخص تذكير واحد بكل مهامه لليوم، داخل المنصة وعلى هاتفه. ألغِ اختيار من لا تريد تذكيره.</p>
      <div class="remind-people">${people.map(({ person: u, tasks: list }) => `<div class="remind-person">
        <label class="check"><input type="checkbox" name="pick" value="${u.id}" data-multi checked>
          ${avatar(u.name, u.id, 'sm')}<span class="grow"><strong>${esc(u.name)}</strong>
          <small>${plural(list.length, TASKS_N)}: ${list.slice(0, 3).map((t) => esc(t.title)).join('، ')}${list.length > 3 ? '…' : ''}</small></span></label>
        <button type="button" class="icon-btn wa-mini" data-wa="${u.id}" aria-label="واتساب ${esc(u.name)}" title="إرسال عبر واتساب">${icon('whatsapp')}</button>
      </div>`).join('')}</div>
      <div class="field"><label>ملاحظة مع التذكير <span class="hint">(اختياري)</span></label>
        <input name="message" maxlength="1000" placeholder="مثال: يُرجى تحديث الحالات قبل الساعة الرابعة"></div>`,
    submitLabel: 'إرسال التذكير',
    onSubmit: async (d) => {
      const picked = new Set((d.pick || []).map(Number));
      if (!picked.size) throw new Error('اختر شخصًا واحدًا على الأقل');
      const { sent, skipped } = await api('POST', '/api/team/remind-today', {
        message: d.message,
        people: people.filter((p) => picked.has(p.person.id)).map((p) => ({ user_id: p.person.id, task_ids: p.tasks.map((t) => t.id) })),
      });
      toast(sent.length ? `أُرسل التذكير إلى ${sent.join('، ')}${skipped.length ? `، وتُرك ${skipped.join('، ')} (ذُكّر قبل قليل)` : ''}`
        : `ذُكّر ${skipped.join('، ')} قبل قليل؛ يمكن التذكير مجددًا بعد عشر دقائق`, { error: !sent.length });
    },
  });
  const count = () => {
    const n = $$('[name=pick]:checked', el).length;
    $('button[type=submit]', el).textContent = n ? `إرسال التذكير (${n})` : 'إرسال التذكير';
  };
  count();
  el.addEventListener('change', count);
  $$('[data-wa]', el).forEach((b) => b.addEventListener('click', () => {
    const p = people.find((x) => x.person.id === Number(b.dataset.wa));
    openWhatsApp(p.person.phone, todayTasksMessage(p.person, p.tasks, $('[name=message]', el).value.trim()), { name: p.person.name });
  }));
  return close;
}

export async function openReminder({ person, relation, task = null, request = null }) {
  let subjects = [];
  if (task) subjects = [{ key: `t${task.id}`, label: `المهمة: ${task.title}`, task }];
  else if (request) subjects = [{ key: `r${request.id}`, label: 'طلب المتطلبات المعلّق', request }];
  else if (relation === 'down') {
    const { tasks } = await api('GET', `/api/tasks?scope=team&assignee=${person.id}`);
    subjects = tasks.filter((t) => t.status !== 'done')
      .map((t) => ({ key: `t${t.id}`, label: `المهمة: ${t.title} (${STATUS_LABELS[t.status]})`, task: t }));
  } else {
    const { requests } = await api('GET', '/api/requests?box=sent');
    subjects = requests.filter((q) => q.recipient_id === person.id && q.status === 'pending').map((q) => ({
      key: `r${q.id}`, request: q,
      label: q.scope === 'project' ? `طلب متطلبات مشروع «${q.project_name}»` : `طلب متطلبات المهمة «${q.task_title}»`,
    }));
  }
  if (!task && !request) subjects.push({ key: 'general', label: 'رسالة عامة' });

  const { el, close } = openModal({
    title: `تذكير ${person.name}`,
    wide: true,
    footer: false,
    body: `
      <div class="row" style="margin-bottom:1rem">${avatar(person.name, person.id)}
        <div class="grow"><strong>${esc(person.name)}</strong><div class="muted small">${esc(person.job_title || ROLE_LABELS[person.role] || '')}</div></div>
        <span class="pill ${relation === 'up' ? 'navy' : 'blue'} plain">${relation === 'up' ? 'من مسؤوليك' : 'من فريقك'}</span></div>
      ${subjects.length > 1 ? `<div class="field"><label>موضوع التذكير</label><select name="subject">
        ${subjects.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}</select></div>` : `<input type="hidden" name="subject" value="${subjects[0].key}">`}
      <div class="field"><label>ملاحظة إضافية <span class="hint" id="note-hint">(اختياري)</span></label>
        <textarea name="note" rows="3" placeholder="${relation === 'up' ? 'مثال: نحتاج إلى الرد قبل اجتماع الغد' : 'مثال: يُرجى تسليمها قبل نهاية اليوم'}"></textarea></div>
      <div class="field"><label>نص رسالة واتساب <span class="hint">— يمكنك تعديله بالكامل قبل الإرسال</span></label>
        <textarea name="text" class="msg-edit" rows="10"></textarea>
        <div class="row wrap" style="gap:.5rem;margin-top:.35rem">
          <span class="hint grow">النص بين نجمتين *هكذا* يظهر بخط عريض.</span>
          <button type="button" class="link-btn small" id="reset-text" hidden>${icon('undo')} استعادة النص المقترح</button></div></div>
      <details class="msg-preview"><summary>معاينة كما ستظهر في واتساب</summary><div class="wa-preview pre" id="preview"></div></details>
      <div class="form-error" role="alert"></div>
      <div class="modal-actions wrap">
        <button type="button" class="btn wa" id="send-wa">${icon('whatsapp')}إرسال عبر واتساب</button>
        <button type="button" class="btn" id="send-app">${icon('bell')}تنبيه داخل المنصة</button>
      </div>
      <p class="muted small" style="margin-top:.5rem">التنبيه داخل المنصة يصل بموضوع التذكير مع ملاحظتك الإضافية.${person.phone ? ''
        : ' لا يوجد رقم واتساب مسجّل لهذا الشخص؛ سيُطلب منك اختيار جهة الاتصال من واتساب.'}</p>`,
  });

  const form = $('form', el);
  const current = () => subjects.find((s) => s.key === form.elements.subject.value);
  const message = () => {
    const s = current();
    const note = form.elements.note.value.trim();
    if (s.task) return taskReminderMessage(s.task, person, note);
    if (s.request) return requestReminderMessage(s.request, person, note);
    return generalMessage(person, relation, note);
  };
  // The suggested text follows the subject and note until the person edits it themselves.
  const area = form.elements.text;
  const resetBtn = $('#reset-text', el);
  let edited = false;
  const refresh = () => {
    if (!edited) area.value = message();
    resetBtn.hidden = !edited;
    $('#preview', el).innerHTML = waPreview(area.value);
    $('#note-hint', el).textContent = current().key === 'general' ? '(مطلوبة)' : '(اختياري)';
  };
  refresh();
  form.addEventListener('input', (e) => { if (e.target === area) edited = area.value !== message(); refresh(); });
  form.addEventListener('change', refresh);
  resetBtn.addEventListener('click', () => { edited = false; refresh(); });
  const error = (msg) => { $('.form-error', el).textContent = msg; };

  $('#send-wa', el).addEventListener('click', () => {
    if (current().key === 'general' && !edited && !form.elements.note.value.trim()) { error('يُرجى كتابة نص التذكير'); return; }
    if (!area.value.trim()) { error('نص الرسالة فارغ'); return; }
    launchWhatsApp(person.phone, area.value);
    close();
  });
  $('#send-app', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const s = current();
    const note = form.elements.note.value.trim();
    try {
      if (s.task) await api('POST', `/api/tasks/${s.task.id}/remind`, { message: note });
      else if (s.request) await api('POST', `/api/requests/${s.request.id}/remind`, { message: note });
      else await api('POST', `/api/users/${person.id}/remind`, { message: note });
    } catch (err) {
      error(err.message);
      return;
    }
    toast(`تم إرسال التذكير إلى ${person.name}`);
    close();
  }));
}
