// Shared state, formatting, API access and UI building blocks.

export const state = { me: null, config: { otp: {}, uploads: false }, lastNotificationId: 0, pollTimer: null, counts: {} };

export const ROLE_LABELS = {
  owner: 'صاحب الشركة', admin: 'مسؤول النظام', manager: 'مدير', team_leader: 'قائد فريق', employee: 'موظف',
};
export const ORG_ROLES = ['owner', 'manager', 'team_leader', 'employee'];
export const STATUS_LABELS = {
  todo: 'لم تبدأ', in_progress: 'قيد التنفيذ', blocked: 'متوقفة', review: 'قيد المراجعة', done: 'مكتملة',
};
export const STATUSES = Object.keys(STATUS_LABELS);
export const PRIORITY_LABELS = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };
export const PROJECT_STATUS = { active: ['نشط', 'blue'], on_hold: ['معلّق', 'amber'], completed: ['مكتمل', 'green'] };
export const REQUEST_STATUS = {
  pending: ['قيد الانتظار', 'amber'], approved: ['مقبول', 'green'], rejected: ['مرفوض', 'red'],
  forwarded: ['أُحيل إلى مستوى أعلى', 'blue'], draft: ['لم يُرسل بعد', 'gray'],
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---------------------------------------------------------------------------
// Icons & brand mark
// ---------------------------------------------------------------------------

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m8 12 3 3 5-6"/>',
  report: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  logout: '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="m15 8 4 4-4 4M19 12H9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 4 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 10v4M12 17.5v.01"/>',
  send: '<path d="M21 3 3 10.5l7.5 3L14 21z"/><path d="m10.5 13.5 4-4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  forward: '<path d="M10 5 4 11l6 6"/><path d="M4 11h10a6 6 0 0 1 6 6v2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  back: '<path d="m9 6 6 6-6 6"/>',
  next: '<path d="m15 6-6 6 6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  reply: '<path d="M10 9 4 14l6 5"/><path d="M4 14h10a6 6 0 0 0 6-6V5"/>',
  pdf: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9.5 14.5 12 17l2.5-2.5"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.5 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  whatsapp: '<path d="M3.5 20.5 4.9 16A8.5 8.5 0 1 1 8 19.1z"/><path d="M9.2 8.6c-.2 2.9 3.2 6.3 6.2 6.2l.9-1.4-1.9-1-.9.7a4.6 4.6 0 0 1-2.6-2.6l.7-.9-1-1.9z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
};

export function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function mark(cls = '') {
  return `<svg class="mark ${cls}" viewBox="12 2 56 96" aria-hidden="true"><path class="mark-arc" d="M60 4A46 46 0 0 0 60 96V78A28 28 0 0 1 60 22Z"/><path class="mark-arrow" d="M34 50 66 33 58 50 66 67Z"/></svg>`;
}

// ---------------------------------------------------------------------------
// Formatting (formal Arabic, Western digits)
// ---------------------------------------------------------------------------

const LOCALE = 'ar-EG-u-nu-latn';
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const dateFmt = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });
const longDateFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const pluralRules = new Intl.PluralRules('ar');

export const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');
export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const fmtLongDate = (d = new Date()) => longDateFmt.format(d);

export function relTime(iso) {
  const diff = (new Date(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'الآن';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(iso);
}

// Arabic counted nouns: forms = { zero, one, two, few, many } with "#" standing for the number.
export function plural(n, forms) {
  const form = forms[pluralRules.select(n)] || forms.many;
  return form.replace('#', n);
}
export const TASKS_N = { zero: 'لا توجد مهام', one: 'مهمة واحدة', two: 'مهمتان', few: '# مهام', many: '# مهمة', other: '# مهمة' };
export const ITEMS_N = { zero: 'لا توجد متطلبات', one: 'متطلب واحد', two: 'متطلبان', few: '# متطلبات', many: '# متطلبًا', other: '# متطلب' };
export const DAYS_N = { zero: '0 يوم', one: 'يوم واحد', two: 'يومان', few: '# أيام', many: '# يومًا', other: '# يوم' };
export const PLAN_LABELS = { trial: 'فترة تجريبية', annual: 'اشتراك سنوي', owned: 'ملكية دائمة' };
export const PLAN_COLORS = { trial: 'amber', annual: 'blue', owned: 'green' };
export const MEMBERS_N = { zero: 'لا يوجد أعضاء', one: 'عضو واحد', two: 'عضوان', few: '# أعضاء', many: '# عضوًا', other: '# عضو' };

export function deadlineInfo(iso, status) {
  if (!iso) return { text: 'بلا موعد نهائي', late: false };
  const late = status !== 'done' && new Date(iso) < new Date();
  return { text: late ? `متأخرة · ${relTime(iso)}` : relTime(iso), late, full: fmtDateTime(iso) };
}

export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

export function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير';
  if (h < 18) return 'طاب يومك';
  return 'مساء الخير';
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('تعذّر الاتصال بالخادم، يُرجى التحقق من الاتصال بالإنترنت');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me) window.dispatchEvent(new Event('session-expired'));
  if (res.status === 402 && state.me) window.dispatchEvent(new CustomEvent('subscription-locked', { detail: data.reason }));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

// ---------------------------------------------------------------------------
// Feedback: toasts, modals
// ---------------------------------------------------------------------------

export function toast(message, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `<span class="badge">${icon(error ? 'alert' : 'check')}</span><span>${esc(message)}</span>`;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, error ? 4500 : 2800);
}

export async function attempt(fn, successMessage) {
  try {
    await fn();
    if (successMessage) toast(successMessage);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

export function openModal({ title, body, submitLabel = 'حفظ', onSubmit, danger = false, wide = false, className = '', footer = true }) {
  const wrap = document.createElement('div');
  wrap.className = `modal-backdrop ${className}`;
  wrap.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="grabber"></div>
      <div class="modal-head"><h2>${esc(title)}</h2>
        <button class="icon-btn" type="button" data-close aria-label="إغلاق">${icon('x')}</button></div>
      <form novalidate>
        ${body}
        <div class="form-error" role="alert"></div>
        ${onSubmit && footer ? `<div class="modal-actions">
          <button class="btn ${danger ? 'danger' : ''}" type="submit">${esc(submitLabel)}</button>
          <button class="btn ghost" type="button" data-close>إلغاء</button>
        </div>` : ''}
      </form>
    </div>`;
  const close = () => {
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 170);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  const form = $('form', wrap);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = $('button[type=submit]', form);
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    try {
      const keep = await onSubmit(formData(form), form);
      if (keep !== true) close();
    } catch (err) {
      $('.form-error', form).textContent = err.message;
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  });
  $('#modal-root').appendChild(wrap);
  const first = $('input:not([type=checkbox]), select, textarea', form);
  if (first && window.matchMedia('(min-width: 641px)').matches) first.focus();
  return { el: wrap, form, close };
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi !== undefined) {
        out[el.name] = out[el.name] || [];
        if (el.checked) out[el.name].push(el.value);
      } else {
        out[el.name] = el.checked;
      }
    } else if (el.type !== 'radio' || el.checked) {
      out[el.name] = el.value;
    }
  }
  return out;
}

export function confirmDialog(message, onConfirm, label = 'تأكيد') {
  openModal({ title: 'تأكيد الإجراء', body: `<p>${esc(message)}</p>`, submitLabel: label, danger: true, onSubmit: onConfirm });
}

// Runs an async action from a button with a spinner and error toast.
export async function busy(button, fn) {
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    await fn();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    if (button.isConnected) { button.disabled = false; button.innerHTML = label; }
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const AVATAR_COLORS = ['#5146E1', '#06044B', '#1FA35C', '#7B72FF', '#0E7490', '#B4236B', '#C2410C'];

export function avatar(name, id = 0, size = '') {
  const initials = String(name || '؟').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
  const color = AVATAR_COLORS[Math.abs(Number(id) || 0) % AVATAR_COLORS.length];
  return `<span class="avatar ${size}" style="--c:${color}" title="${esc(name)}">${esc(initials)}</span>`;
}

export const statusPill = (status, cls = '') => `<span class="pill st-${status} ${cls}">${STATUS_LABELS[status]}</span>`;
export const pill = ([label, color], cls = '') => `<span class="pill ${color} ${cls}">${esc(label)}</span>`;

export function emptyState(title, text = '', action = '') {
  return `<div class="empty">${mark()}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}

export const loader = () => `<div class="loader">${mark('spin')}</div>`;

export function personLine(u) {
  return u.job_title ? `${esc(u.job_title)}` : esc(ROLE_LABELS[u.role] || '');
}

export function taskCard(t, { showProject = true, showAssignee = false, i = 0 } = {}) {
  const dl = deadlineInfo(t.deadline, t.status);
  return `<article class="task s-${t.status}" data-href="#/tasks/${t.id}" style="--i:${Math.min(i, 12)}">
    <div class="grow">
      <div class="t-title">${esc(t.title)}</div>
      ${t.status_note ? `<div class="t-note">${t.status === 'blocked' ? '⛔ ' : ''}${esc(t.status_note)}</div>` : ''}
      <div class="t-meta">
        ${showProject && t.project_name ? `<span>${icon('folder')}${esc(t.project_name)}</span>` : ''}
        ${showAssignee ? `<span>${avatar(t.assignee_name, t.assignee_id, 'sm')}${esc(t.assignee_name)}</span>` : ''}
        <span class="${dl.late ? 'late' : ''}" title="${esc(dl.full || '')}">${icon('clock')}${esc(dl.text)}</span>
        <span class="prio-${t.priority}">${icon('flag')}${PRIORITY_LABELS[t.priority]}</span>
      </div>
    </div>
    <div class="t-side">${statusPill(t.status)}</div>
  </article>`;
}

export function taskList(tasks, opts = {}) {
  if (!tasks.length) return emptyState(opts.emptyTitle || 'لا توجد مهام', opts.emptyText || '');
  return `<div class="tasks-list stagger">${tasks.map((t, i) => taskCard(t, { ...opts, i })).join('')}</div>`;
}

// Any element with data-href becomes a link (cards, rows), unless the click hit a real control.
export function bindLinks(root) {
  $$('[data-href]', root).forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      location.hash = el.dataset.href;
    });
  });
}

// Animated counters and bars, run after a view is in the DOM.
export function animateIn(root) {
  requestAnimationFrame(() => {
    $$('[data-width]', root).forEach((el) => { el.style.width = `${el.dataset.width}%`; });
    $$('.ring[data-p]', root).forEach((el) => { el.style.setProperty('--p', el.dataset.p); });
  });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $$('[data-count]', root).forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    if (reduce || target === 0) { el.textContent = target; return; }
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / 700);
      el.textContent = Math.round(target * (1 - (1 - p) ** 3));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export function kpi(value, label, iconName, tone = '', href = '') {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${tone}" ${href ? `href="${href}"` : ''}>
    <span class="ic">${icon(iconName)}</span>
    <span class="num" data-count="${value || 0}">0</span>
    <span class="label">${esc(label)}</span>
  </${tag}>`;
}

export function stackBar(s) {
  const total = STATUSES.reduce((n, k) => n + (s[k] || 0), 0);
  if (!total) return '<div class="stackbar"></div>';
  return `<div class="stackbar" title="${STATUSES.map((k) => `${STATUS_LABELS[k]}: ${s[k] || 0}`).join(' · ')}">
    ${STATUSES.map((k) => (s[k] ? `<span class="b-${k}" style="flex-grow:${s[k]}"></span>` : '')).join('')}</div>`;
}

// Entrance animations play when arriving on a page, not when the same page refreshes in place.
let lastRendered = null;

export function render(html) {
  const el = $('#view');
  el.classList.toggle('quiet', lastRendered === location.hash);
  lastRendered = location.hash;
  el.innerHTML = html;
  bindLinks(el);
  animateIn(el);
  tickCountdowns(el);
  return el;
}

export function tabs(items, active) {
  return `<div class="tabs" role="tablist">${items.map(([key, label]) =>
    `<a href="#" role="tab" data-tab="${key}" class="${key === active ? 'active' : ''}">${label}</a>`).join('')}</div>`;
}

export function onTabs(root, fn) {
  $$('[data-tab]', root).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    fn(a.dataset.tab);
  }));
}

export function remember(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    sessionStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
  return value;
}

export function setTitle(text) {
  $('#topbar-title').textContent = text;
  document.title = `${text} — ابتكار`;
}

// The floating "+" button on phones; each view decides what it does (or hides it).
export function setFab(label, fn) {
  const fab = $('#fab');
  fab.onclick = fn || null;
  fab.classList.toggle('hidden', !fn);
  if (fn) {
    fab.innerHTML = icon('plus');
    fab.setAttribute('aria-label', label);
  }
}

// ---------------------------------------------------------------------------
// Live countdowns: any element with data-ends updates every second.
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

export function urgency(endsAt) {
  if (!endsAt) return 'green';
  const days = (new Date(endsAt) - Date.now()) / 86400000;
  if (days <= 0) return 'red';
  if (days <= 7) return 'red';
  if (days <= 30) return 'amber';
  return 'green';
}

export function countdown(endsAt, { big = false } = {}) {
  if (!endsAt) return `<span class="countdown done ${big ? 'big' : ''}">${big ? '<b>∞</b><small>ملكية دائمة دون انتهاء</small>' : 'دون انتهاء'}</span>`;
  return `<span class="countdown ${big ? 'big' : ''} u-${urgency(endsAt)}" data-ends="${esc(endsAt)}" data-big="${big ? 1 : ''}"></span>`;
}

function renderCountdown(el) {
  const ms = new Date(el.dataset.ends) - Date.now();
  const big = !!el.dataset.big;
  if (ms <= 0) {
    el.innerHTML = big ? '<b>انتهى</b><small>انقضت مدة الاشتراك</small>' : 'منتهٍ';
    el.className = `countdown u-red${big ? ' big done expired' : ''}`;
    return;
  }
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  el.innerHTML = big
    ? `<span class="cd"><b>${d}</b><small>يوم</small></span><span class="cd"><b>${pad2(h)}</b><small>ساعة</small></span>
       <span class="cd"><b>${pad2(m)}</b><small>دقيقة</small></span><span class="cd"><b>${pad2(sec)}</b><small>ثانية</small></span>`
    : `${plural(d, DAYS_N)} <span dir="ltr">${pad2(h)}:${pad2(m)}:${pad2(sec)}</span>`;
}

export function tickCountdowns(root = document) {
  root.querySelectorAll('[data-ends]').forEach(renderCountdown);
}
setInterval(() => tickCountdowns(), 1000);

// Share of the subscription period already used (for progress bars).
export function periodUsed(startsAt, endsAt) {
  if (!endsAt) return 0;
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  return Math.max(0, Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100)));
}
