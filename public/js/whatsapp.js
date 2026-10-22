// WhatsApp messages prepared for each recipient. Writing upward (to one's manager or higher) uses a
// formal address and closing; writing downward (to one's team) uses a collegial, direct tone.

import {
  state, $, esc, icon, toast, openModal, genderOf, colleagueTitle,
  STATUS_LABELS, PRIORITY_LABELS, fmtDate, fmtDateTime, plural, TASKS_N, ITEMS_N, DAYS_N,
} from './core.js';

// Without a number WhatsApp opens its contact picker.
export function waUrl(phone, text) {
  return `https://wa.me/${String(phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

export function launchWhatsApp(phone, text) {
  window.open(waUrl(phone, text), '_blank', 'noopener');
}

// Shows *bold* the way WhatsApp will.
export function waPreview(text) {
  return esc(text).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
}

// Every WhatsApp message is reviewed first: the number and the whole text can be changed (or the text
// copied) before anything leaves; nothing is sent until "إرسال" is pressed.
export function openWhatsApp(phone, text, { name = '' } = {}) {
  const digits = String(phone || '').replace(/\D/g, '');
  const { el, close } = openModal({
    title: 'مراجعة الرسالة قبل الإرسال',
    wide: true,
    footer: false,
    body: `
      <p class="muted small" style="margin-top:0">يمكنك تعديل الرقم ونص الرسالة كما تشاء؛ لن يُرسل شيء قبل الضغط على «إرسال عبر واتساب».</p>
      <div class="field"><label>رقم واتساب${name ? ` — ${esc(name)}` : ''} <span class="hint">(اتركه فارغًا لاختيار جهة الاتصال من واتساب)</span></label>
        <input name="phone" type="tel" dir="ltr" value="${digits ? `+${digits}` : ''}" placeholder="2010xxxxxxxx+"></div>
      <div class="field"><label>نص الرسالة</label>
        <textarea name="text" class="msg-edit" rows="12">${esc(text)}</textarea>
        <span class="hint">النص بين نجمتين *هكذا* يظهر بخط عريض في واتساب.</span></div>
      <details class="msg-preview"><summary>معاينة كما ستظهر في واتساب</summary><div class="wa-preview pre" data-preview></div></details>
      <div class="modal-actions wrap">
        <button type="button" class="btn wa" data-send>${icon('whatsapp')}إرسال عبر واتساب</button>
        <button type="button" class="btn ghost" data-copy>${icon('copy')}نسخ النص</button>
        <button type="button" class="btn ghost" data-reset disabled>${icon('undo')}استعادة النص المقترح</button>
      </div>`,
  });
  const area = $('[name=text]', el);
  const reset = $('[data-reset]', el);
  const sync = () => {
    $('[data-preview]', el).innerHTML = waPreview(area.value);
    reset.disabled = area.value === text;
  };
  sync();
  area.addEventListener('input', sync);
  reset.addEventListener('click', () => { area.value = text; sync(); area.focus(); });
  $('[data-copy]', el).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(area.value);
      toast('تم نسخ نص الرسالة');
    } catch {
      area.select();
      toast('حدّد النص وانسخه يدويًا', { error: true });
    }
  });
  $('[data-send]', el).addEventListener('click', () => {
    if (!area.value.trim()) { toast('نص الرسالة فارغ', { error: true }); return; }
    launchWhatsApp($('[name=phone]', el).value, area.value);
    close();
  });
}

const appLink = (hash) => `${location.origin}/${hash}`;

// Formal address that follows the recipient's gender (both forms when it is not set).
export function formalTitle(person) {
  const gender = genderOf(person);
  if (gender === 'male') return `حضرة الأستاذ ${person.name} المحترم،`;
  if (gender === 'female') return `حضرة الأستاذة ${person.name} المحترمة،`;
  return `حضرة الأستاذ/ة ${person.name} المحترم/ة،`;
}

function salutation(person, relation) {
  if (relation === 'up') return `${formalTitle(person)}\nتحية طيبة وبعد،`;
  const dear = { male: 'الزميل العزيز', female: 'الزميلة العزيزة' }[genderOf(person)] || 'الزميل/ة العزيز/ة';
  return `${dear} ${person.name}،\nتحية طيبة،`;
}

function closing(relation) {
  const me = state.me;
  const sign = `${me.name}${me.job_title ? `\n${me.job_title}` : ''}`;
  return relation === 'up'
    ? `\nوتفضلوا بقبول فائق الاحترام والتقدير،\n${sign}`
    : `\nمع خالص التحية،\n${sign}`;
}

export function reportMessage(report, recipient, relation = 'up') {
  const me = state.me;
  const s = report.snapshot && report.snapshot.summary;
  const lines = [salutation(recipient, relation), ''];
  lines.push(report.sender_id === me.id
    ? `أرفع إليكم *${report.title}* بتاريخ ${fmtDate(report.created_at)}.`
    : `أرفع إليكم *${report.title}* المقدَّم من ${colleagueTitle({ id: report.sender_id, name: report.sender_name })} بتاريخ ${fmtDate(report.created_at)}.`);
  lines.push('', report.body);
  if (s) {
    lines.push('', '*ملخص حالة العمل:*',
      `• إجمالي المهام: ${s.total}`, `• قيد التنفيذ: ${s.in_progress}`, `• قيد المراجعة: ${s.review}`,
      `• متوقفة: ${s.blocked}`, `• متأخرة عن موعدها: ${s.overdue}`, `• مكتملة: ${s.done}`);
    const tasks = report.snapshot.tasks.slice(0, 15);
    if (tasks.length) {
      lines.push('', '*تفاصيل المهام:*');
      tasks.forEach((t, i) => {
        lines.push(`${i + 1}. ${t.title} — ${STATUS_LABELS[t.status]}${t.status_note ? ` (${t.status_note})` : ''}`);
        if (t.deadline) lines.push(`   الموعد النهائي: ${fmtDate(t.deadline)}${t.overdue ? ' — متأخرة' : ''}`);
      });
      if (report.snapshot.tasks.length > tasks.length) lines.push(`… و${plural(report.snapshot.tasks.length - tasks.length, TASKS_N)} أخرى على المنصة`);
    }
    if (report.snapshot.team && report.snapshot.team.length) {
      lines.push('', '*ملخص الفريق:*');
      for (const m of report.snapshot.team) {
        lines.push(`• ${m.name}: قيد التنفيذ ${m.in_progress}، متوقفة ${m.blocked}، متأخرة ${m.overdue}`);
      }
    }
  }
  const images = [...(report.images || []), ...((report.snapshot && report.snapshot.tasks) || []).flatMap((t) => t.images || [])];
  if (images.length) {
    lines.push('', '*الصور المرفقة:*', ...images.slice(0, 8).map((img) => (img.url.startsWith('/') ? `${location.origin}${img.url}` : img.url)));
  }
  lines.push('', 'رابط التقرير على منصة ابتكار:', appLink(`#/reports/${report.id}`), closing(relation));
  return lines.join('\n');
}

export function taskReminderMessage(task, person, note = '') {
  const late = task.status !== 'done' && task.deadline && new Date(task.deadline) < new Date();
  const lines = [salutation(person, 'down'), ''];
  lines.push(`نودّ تذكيركم بالمهمة *«${task.title}»*${task.standalone ? '' : ` ضمن «${task.project_name}»`}.`);
  lines.push(`• الحالة الحالية: ${STATUS_LABELS[task.status]}`, `• الأولوية: ${PRIORITY_LABELS[task.priority]}`);
  if (task.deadline) lines.push(`• الموعد النهائي: ${fmtDateTime(task.deadline)}${late ? ' (متأخرة)' : ''}`);
  if (note) lines.push('', note);
  lines.push('', 'نرجو متابعتها وإنجازها في موعدها، مع تحديث حالتها على المنصة.', appLink(`#/tasks/${task.id}`), closing('down'));
  return lines.join('\n');
}

export function requestReminderMessage(request, person, note = '') {
  const what = request.scope === 'project' ? `متطلبات مشروع «${request.project_name}»` : `متطلبات المهمة «${request.task_title}»`;
  const lines = [salutation(person, 'up'), ''];
  lines.push(`أودّ تذكيركم بطلب *${what}* المرسل بتاريخ ${fmtDate(request.created_at)}، والذي لا يزال بانتظار ردّكم الكريم.`);
  lines.push(`• عدد المتطلبات: ${plural(request.items_count, ITEMS_N)}`);
  if (note) lines.push('', note);
  lines.push('', 'رابط الطلب على المنصة:', appLink(`#/requests/${request.id}`), closing('up'));
  return lines.join('\n');
}

export function generalMessage(person, relation, note) {
  return [salutation(person, relation), '', note || '…', closing(relation)].join('\n');
}

// A company's owner/admin asking the platform team to renew.
export function renewalRequestMessage(company, note = '') {
  const me = state.me;
  const lines = ['حضرة إدارة منصة ابتكار المحترمين،', 'تحية طيبة وبعد،', ''];
  lines.push(`نرغب في تجديد اشتراك شركة *«${company.name}»* في منصة ابتكار.`);
  lines.push(`• نوع الاشتراك الحالي: ${company.plan_label}`);
  if (company.ends_at) lines.push(`• ${company.ok ? 'ينتهي في' : 'انتهى في'}: ${fmtDate(company.ends_at)}`);
  if (company.seats_used !== undefined) lines.push(`• الحسابات المستخدمة: ${company.seats_used}${company.seats ? ` من ${company.seats}` : ''}`);
  if (note) lines.push('', note);
  lines.push('', 'وتفضلوا بقبول فائق الاحترام والتقدير،', `${me.name}${me.job_title ? `\n${me.job_title}` : ''}`, `شركة ${company.name}`);
  return lines.join('\n');
}

// The platform owner reminding a company's owner to renew.
export function renewalReminderMessage(company) {
  const owner = company.owner;
  const lines = [formalTitle(owner), 'تحية طيبة وبعد،', ''];
  const what = company.plan === 'trial' ? 'الفترة التجريبية لشركة' : 'اشتراك شركة';
  lines.push(company.ok
    ? `نودّ تذكيركم بأن ${what} *«${company.name}»* في منصة ابتكار تنتهي بتاريخ ${fmtDate(company.ends_at)}، والمتبقي ${plural(company.days_left, DAYS_N)}.`
    : `نودّ إعلامكم بأن ${what} *«${company.name}»* في منصة ابتكار انتهى بتاريخ ${fmtDate(company.ends_at)}، وقد توقفت الخدمة مؤقتًا إلى حين التجديد.`);
  lines.push('', 'يسعدنا تجديد اشتراككم ومواصلة خدمتكم، ويمكنكم الرد على هذه الرسالة لإتمام التجديد أو تعديل عدد الحسابات.');
  lines.push('', 'مع خالص التحية،', `${state.me.name}`, 'إدارة منصة ابتكار — Ebtikar Software Solutions');
  return lines.join('\n');
}
