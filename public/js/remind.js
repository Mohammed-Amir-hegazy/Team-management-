// Reminder composer: about a task (to someone in my team), a pending request (to someone above me),
// or a general note. Sent as an in-app alert and/or a WhatsApp message worded for the recipient.

import { $, esc, icon, api, toast, openModal, avatar, busy, STATUS_LABELS, ROLE_LABELS } from './core.js';
import { openWhatsApp, taskReminderMessage, requestReminderMessage, generalMessage } from './whatsapp.js';

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
      <div class="field"><label>نص الرسالة كما سيصل</label><div class="wa-preview pre" id="preview"></div></div>
      <div class="form-error" role="alert"></div>
      <div class="modal-actions wrap">
        <button type="button" class="btn wa" id="send-wa" ${person.phone ? '' : 'disabled'}>${icon('whatsapp')}إرسال عبر واتساب</button>
        <button type="button" class="btn" id="send-app">${icon('bell')}تنبيه داخل المنصة</button>
      </div>
      ${person.phone ? '' : '<p class="muted small" style="margin-top:.5rem">لا يوجد رقم واتساب مسجّل لهذا الشخص؛ يمكن لمسؤول النظام إضافته.</p>'}`,
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
  const refresh = () => {
    // Show WhatsApp's *bold* the way the recipient will see it.
    $('#preview', el).innerHTML = esc(message()).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    $('#note-hint', el).textContent = current().key === 'general' ? '(مطلوبة)' : '(اختياري)';
  };
  refresh();
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  const error = (msg) => { $('.form-error', el).textContent = msg; };

  $('#send-wa', el).addEventListener('click', () => {
    if (current().key === 'general' && !form.elements.note.value.trim()) { error('يُرجى كتابة نص التذكير'); return; }
    openWhatsApp(person.phone, message());
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
