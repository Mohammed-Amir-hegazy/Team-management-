'use strict';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const ROLE_LABELS = { owner: 'صاحب الشركة', manager: 'مدير', team_leader: 'تيم ليدر', employee: 'موظف' };
const ROLES = ['owner', 'manager', 'team_leader', 'employee'];
const STATUS_LABELS = {
  todo: 'لم تبدأ', in_progress: 'قيد التنفيذ', blocked: 'متوقفة', review: 'قيد المراجعة', done: 'مكتملة',
};
const PRIORITY_LABELS = { low: 'منخفضة', medium: 'متوسطة', high: 'عالية' };
const PROJECT_STATUS = { active: ['نشط', 'blue'], on_hold: ['متوقف مؤقتاً', 'amber'], completed: ['مكتمل', 'green'] };
const REQUEST_STATUS = {
  pending: ['في الانتظار', 'amber'], approved: ['تمت الموافقة', 'green'],
  rejected: ['مرفوض', 'red'], forwarded: ['تم تحويله لأعلى', 'blue'], draft: ['لم يُرسل بعد', 'gray'],
};
const ALARM_TYPES = new Set(['reminder', 'overdue']);

const state = { me: null, pollTimer: null, lastNotificationId: 0 };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const dateFmt = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
function fmtDate(iso) {
  return iso ? dateFmt.format(new Date(iso)) : '—';
}
function relDeadline(iso, status) {
  if (!iso) return '<span class="muted">بدون ديدلاين</span>';
  const late = status !== 'done' && new Date(iso) < new Date();
  return `<span class="${late ? 'overdue' : ''}">${late ? '⚠️ ' : ''}${esc(fmtDate(iso))}</span>`;
}
// ISO -> value for <input type="datetime-local"> in the viewer's timezone.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : null;
}

function statusPill(status) {
  return `<span class="pill st-${status}">${STATUS_LABELS[status]}</span>`;
}
function pill([label, color]) {
  return `<span class="pill ${color}">${esc(label)}</span>`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me) {
    state.me = null;
    showAuth();
  }
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// Runs an async action from a button, reporting errors as a toast.
async function attempt(fn, successMessage) {
  try {
    await fn();
    if (successMessage) toast(successMessage);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openModal({ title, body, submitLabel = 'حفظ', onSubmit, danger = false, extraClass = '' }) {
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = `modal-backdrop ${extraClass}`;
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="إغلاق">✕</button></div>
      <form novalidate>
        ${body}
        <div class="form-error"></div>
        ${onSubmit ? `<div class="modal-actions">
          <button class="btn ${danger ? 'danger' : ''}" type="submit">${esc(submitLabel)}</button>
          <button class="btn ghost" type="button" data-close>إلغاء</button>
        </div>` : ''}
      </form>
    </div>`;
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  const form = $('form', wrap);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const data = formData(form);
      const keep = await onSubmit(data, form);
      if (keep !== true) close();
    } catch (err) {
      $('.form-error', form).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  root.appendChild(wrap);
  const first = $('input, select, textarea', form);
  if (first) first.focus();
  return { el: wrap, close };
}

function formData(form) {
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
    } else {
      out[el.name] = el.value;
    }
  }
  return out;
}

function confirmModal(message, onConfirm, label = 'تأكيد') {
  openModal({ title: 'تأكيد', body: `<p>${esc(message)}</p>`, submitLabel: label, danger: true, onSubmit: onConfirm });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const { user } = await api('GET', '/api/me');
    state.me = user;
    showApp();
  } catch {
    showAuth();
  }
}

async function showAuth() {
  stopPolling();
  $('#shell').classList.add('hidden');
  const el = $('#auth');
  el.classList.remove('hidden');
  const { needsSetup } = await api('GET', '/api/setup-status');
  el.innerHTML = `
    <div class="card">
      <h1>إدارة الشغل</h1>
      <p class="muted">${needsSetup ? 'أول مرة؟ أنشئ حساب صاحب الشركة.' : 'سجّل دخولك للمتابعة'}</p>
      <form id="auth-form">
        ${needsSetup ? '<div class="field"><label>الاسم</label><input name="name" required></div>' : ''}
        <div class="field"><label>البريد الإلكتروني</label><input name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label>كلمة المرور</label><input name="password" type="password" required autocomplete="${needsSetup ? 'new-password' : 'current-password'}"></div>
        <div class="form-error"></div>
        <button class="btn big" type="submit" style="width:100%">${needsSetup ? 'إنشاء الحساب' : 'دخول'}</button>
      </form>
    </div>`;
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('POST', needsSetup ? '/api/setup' : '/api/login', formData(e.target));
      state.me = user;
      showApp();
    } catch (err) {
      $('.form-error', e.target).textContent = err.message;
    }
  });
}

function showApp() {
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  const me = state.me;
  $('#me').innerHTML = `${esc(me.name)}<span class="role">${esc(ROLE_LABELS[me.role])}${
    me.supervisor_name ? ` · تابع لـ ${esc(me.supervisor_name)}` : ''}</span>`;
  try {
    state.lastNotificationId = Number(localStorage.getItem(`alarmSeen:${me.id}`)) || 0;
  } catch {
    state.lastNotificationId = 0;
  }
  if (!location.hash) location.hash = '#/dashboard';
  route();
  startPolling();
}

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  state.me = null;
  location.hash = '';
  showAuth();
});

$('#password-btn').addEventListener('click', () => {
  openModal({
    title: 'تغيير كلمة المرور',
    body: `
      <div class="field"><label>كلمة المرور الحالية</label><input type="password" name="current_password" required></div>
      <div class="field"><label>كلمة المرور الجديدة</label><input type="password" name="new_password" required minlength="6"></div>`,
    onSubmit: async (d) => {
      await api('POST', '/api/me/password', d);
      toast('تم تغيير كلمة المرور');
    },
  });
});

$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

// ---------------------------------------------------------------------------
// Notifications polling & alarm
// ---------------------------------------------------------------------------

function startPolling() {
  stopPolling();
  pollNotifications();
  state.pollTimer = setInterval(pollNotifications, 30000);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollNotifications() {
  if (!state.me) return;
  try {
    const { notifications, unread, unread_reports: reports, pending_requests: requests } = await api('GET', '/api/notifications');
    setBadge('notifications', unread);
    $('#bell-dot').classList.toggle('hidden', unread === 0);
    setBadge('reports', reports);
    setBadge('requests', requests);

    const fresh = notifications.filter((n) => n.id > state.lastNotificationId);
    const firstVisit = state.lastNotificationId === 0;
    if (fresh.length) {
      state.lastNotificationId = Math.max(...fresh.map((n) => n.id));
      try { localStorage.setItem(`alarmSeen:${state.me.id}`, state.lastNotificationId); } catch { /* ignore */ }
      const alarms = fresh.filter((n) => ALARM_TYPES.has(n.type) && !n.read_at);
      if (alarms.length) showAlarm(alarms);
      if (!firstVisit) for (const n of fresh.filter((x) => !x.read_at)) browserNotify(n);
    }
  } catch { /* offline: try again next tick */ }
}

function setBadge(name, count) {
  const el = $(`#badge-${name}`);
  el.textContent = count;
  el.classList.toggle('hidden', !count);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.25, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.3);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.3);
    });
  } catch { /* audio not available */ }
}

function browserNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const note = new Notification('إدارة الشغل', { body: n.message, tag: `n${n.id}` });
  note.onclick = () => { window.focus(); if (n.link) location.hash = n.link; };
}

function showAlarm(alarms) {
  beep();
  const items = alarms.map((n) => `
    <div class="list-item"><div class="grow">${esc(n.message)}</div>
    ${n.link ? `<a class="btn small" href="${esc(n.link)}" data-close data-read="${n.id}">فتح</a>` : ''}</div>`).join('');
  const { el } = openModal({
    title: 'تنبيه',
    extraClass: 'alarm',
    body: `<div class="big-icon">⏰</div><div class="list-items">${items}</div>
      <div class="modal-actions" style="justify-content:center"><button class="btn" type="button" data-close data-read-all>تمام</button></div>`,
  });
  el.addEventListener('click', (e) => {
    const one = e.target.closest('[data-read]');
    if (one) api('POST', `/api/notifications/${one.dataset.read}/read`, {}).catch(() => {});
    if (e.target.closest('[data-read-all]')) {
      for (const n of alarms) api('POST', `/api/notifications/${n.id}/read`, {}).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = {
  dashboard: viewDashboard,
  projects: (id) => (id ? viewProject(id) : viewProjects()),
  tasks: (id) => (id ? viewTask(id) : viewTasks()),
  reports: (id) => (id ? viewReport(id) : viewReports()),
  requests: (id) => (id ? viewRequest(id) : viewRequests()),
  team: viewTeam,
  notifications: viewNotifications,
};

async function route() {
  if (!state.me) return;
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  const view = routes[name] || routes.dashboard;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (routes[name] ? name : 'dashboard')));
  $('#sidebar').classList.remove('open');
  pollNotifications();
  const el = $('#view');
  el.innerHTML = '<p class="muted">جاري التحميل…</p>';
  try {
    await view(id);
  } catch (err) {
    el.innerHTML = `<div class="card"><p>${esc(err.message)}</p><a href="#/dashboard">الرجوع للرئيسية</a></div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function render(html) {
  const el = $('#view');
  el.innerHTML = html;
  return el;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function taskRows(tasks, { showProject = true, showAssignee = false } = {}) {
  if (!tasks.length) return '<div class="empty">لا توجد تاسكات</div>';
  return `<div class="table-wrap"><table class="list">
    <thead><tr><th>التاسك</th>${showProject ? '<th>المشروع</th>' : ''}${showAssignee ? '<th>المسؤول</th>' : ''}
      <th>الحالة</th><th>الديدلاين</th></tr></thead>
    <tbody>${tasks.map((t) => `
      <tr class="clickable" data-href="#/tasks/${t.id}">
        <td><strong>${esc(t.title)}</strong>${t.status_note ? `<div class="muted small">${esc(t.status_note)}</div>` : ''}</td>
        ${showProject ? `<td>${esc(t.project_name)}</td>` : ''}
        ${showAssignee ? `<td>${esc(t.assignee_name)}</td>` : ''}
        <td>${statusPill(t.status)}</td>
        <td>${relDeadline(t.deadline, t.status)}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

function bindRowLinks(root) {
  $$('[data-href]', root).forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    location.hash = row.dataset.href;
  }));
}

async function viewDashboard() {
  const d = await api('GET', '/api/dashboard');
  const s = d.my_tasks_by_status;
  const stat = (num, label, href) => `<a class="stat" href="${href}"><div class="num">${num || 0}</div><div class="label">${label}</div></a>`;
  const el = render(`
    <div class="page-head"><h1>أهلاً ${esc(state.me.name)} 👋</h1></div>
    <div class="stats">
      ${stat(s.todo, 'لم تبدأ', '#/tasks')}
      ${stat(s.in_progress, 'قيد التنفيذ', '#/tasks')}
      ${stat(s.blocked, 'متوقفة', '#/tasks')}
      ${stat(s.review, 'قيد المراجعة', '#/tasks')}
      ${stat(s.done, 'مكتملة', '#/tasks')}
      ${stat(d.unread_reports, 'ريبورتات غير مقروءة', '#/reports')}
      ${stat(d.pending_requests, 'طلبات مستنية ردك', '#/requests')}
    </div>
    <div class="grid cols-2">
      <section class="card"><h2>⚠️ تاسكات عدّت الديدلاين</h2>${taskRows(d.overdue)}</section>
      <section class="card"><h2>📅 ديدلاينز الأسبوع ده</h2>${taskRows(d.upcoming)}</section>
      ${d.team_size ? `
      <section class="card"><h2>🛑 تاسكات متوقفة في فريقك</h2>${taskRows(d.team_blocked, { showAssignee: true })}</section>
      <section class="card"><h2>⏳ تاسكات متأخرة في فريقك</h2>${taskRows(d.team_overdue, { showAssignee: true })}</section>` : ''}
    </div>`);
  bindRowLinks(el);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function viewProjects() {
  const { projects } = await api('GET', '/api/projects');
  const canCreate = state.me.role !== 'employee';
  const el = render(`
    <div class="page-head"><h1>المشاريع</h1>
      <div class="actions">${canCreate ? '<button class="btn" id="new-project">+ مشروع جديد</button>' : ''}</div></div>
    ${projects.length ? `<div class="grid cards">${projects.map((p) => {
      const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
      return `<div class="card project-card" data-href="#/projects/${p.id}">
        <div style="display:flex;gap:.5rem;align-items:center"><h3 style="margin:0">${esc(p.name)}</h3>
          <span style="margin-inline-start:auto">${pill(PROJECT_STATUS[p.status])}</span></div>
        <p class="muted small">${esc(p.description || 'بدون وصف').slice(0, 140)}</p>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="meta"><span>${p.tasks_done}/${p.tasks_total} تاسك (${pct}%)</span>
          <span>👥 ${p.members_count}</span>
          ${p.my_open_tasks ? `<span>📌 ${p.my_open_tasks} ليك</span>` : ''}
          ${p.tasks_blocked ? `<span class="overdue">🛑 ${p.tasks_blocked} متوقفة</span>` : ''}
          ${p.tasks_overdue ? `<span class="overdue">⚠️ ${p.tasks_overdue} متأخرة</span>` : ''}</div>
      </div>`;
    }).join('')}</div>` : '<div class="card empty">لا توجد مشاريع متاحة لك حالياً</div>'}`);
  bindRowLinks(el);
  if (canCreate) $('#new-project').addEventListener('click', newProjectModal);
}

async function newProjectModal() {
  const { users } = await api('GET', '/api/users');
  const team = users.filter((u) => u.manageable && u.active);
  openModal({
    title: 'مشروع جديد',
    body: `
      <div class="field"><label>اسم المشروع</label><input name="name" required></div>
      <div class="field"><label>الوصف</label><textarea name="description"></textarea></div>
      ${team.length ? `<div class="field"><label>أعضاء المشروع</label><div class="checks">
        ${team.map((u) => `<label><input type="checkbox" name="member_ids" value="${u.id}" data-multi>
          ${esc(u.name)} <span class="muted small">(${esc(ROLE_LABELS[u.role])})</span></label>`).join('')}
      </div></div>` : ''}`,
    submitLabel: 'إنشاء',
    onSubmit: async (d) => {
      const { project } = await api('POST', '/api/projects', { ...d, member_ids: (d.member_ids || []).map(Number) });
      location.hash = `#/projects/${project.id}`;
    },
  });
}

async function viewProject(id) {
  const data = await api('GET', `/api/projects/${id}`);
  const { project: p, members, tasks, permissions: can } = data;
  const filter = sessionStorage.getItem('projectFilter') || 'all';
  const shown = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((s) => [s, tasks.filter((t) => t.status === s).length]));

  const el = render(`
    <div class="page-head">
      <h1>${esc(p.name)}</h1> ${pill(PROJECT_STATUS[p.status])}
      <div class="actions">
        <button class="btn" id="new-task">+ تاسك جديدة</button>
        <button class="btn ghost" id="project-report">📝 ريبورت عن المشروع</button>
        ${can.manage ? '<button class="btn ghost" id="edit-project">تعديل</button><button class="btn ghost" id="delete-project">حذف</button>' : ''}
      </div>
    </div>
    ${p.description ? `<div class="card pre">${esc(p.description)}</div>` : ''}

    ${can.send_requests ? `<div class="send-bar">
      <div><strong>📦 طلبات المشروع:</strong> عندك <strong>${data.my_draft_requirements}</strong> طلب جاهز للإرسال من كل التاسكات</div>
      <button class="btn" id="send-project-reqs" style="margin-inline-start:auto" ${data.my_draft_requirements ? '' : 'disabled'}>
        إرسال كل طلبات المشروع لـ ${esc(state.me.supervisor_name || '')}</button>
    </div>` : ''}

    <section class="card section" style="margin-top:1rem">
      <div class="page-head" style="margin-bottom:.4rem"><h2 style="margin:0">الأعضاء (${members.length})</h2>
        <div class="actions">${can.add_members && data.addable_users.length ? '<button class="btn small ghost" id="add-member">+ إضافة عضو</button>' : ''}</div></div>
      <div class="chips">${members.map((m) => `<span class="chip">${esc(m.name)}
        <span class="muted small">${esc(ROLE_LABELS[m.role])}</span>
        ${m.removable && m.id !== p.created_by ? `<button data-remove-member="${m.id}" title="إزالة">×</button>` : ''}</span>`).join('')}</div>
    </section>

    <section class="card section">
      <h2>التاسكات</h2>
      <div class="tabs">
        <a href="#" data-filter="all" class="${filter === 'all' ? 'active' : ''}">الكل (${tasks.length})</a>
        ${Object.entries(STATUS_LABELS).map(([s, l]) => `<a href="#" data-filter="${s}" class="${filter === s ? 'active' : ''}">${l} (${counts[s]})</a>`).join('')}
      </div>
      ${shown.length ? `<div class="table-wrap"><table class="list">
        <thead><tr><th>التاسك</th><th>المسؤول</th><th>الحالة</th><th>الأولوية</th><th>الديدلاين</th><th>طلبات</th></tr></thead>
        <tbody>${shown.map((t) => `<tr class="clickable" data-href="#/tasks/${t.id}">
          <td><strong>${esc(t.title)}</strong>${t.status_note ? `<div class="muted small">${t.status === 'blocked' ? '🛑 ' : ''}${esc(t.status_note)}</div>` : ''}</td>
          <td>${esc(t.assignee_name)}</td><td>${statusPill(t.status)}</td>
          <td>${PRIORITY_LABELS[t.priority]}</td><td>${relDeadline(t.deadline, t.status)}</td>
          <td>${t.requirements_count || ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">لا توجد تاسكات</div>'}
    </section>`);

  bindRowLinks(el);
  $$('[data-filter]', el).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    sessionStorage.setItem('projectFilter', a.dataset.filter);
    viewProject(id);
  }));
  $('#new-task').addEventListener('click', () => taskFormModal({ projectId: p.id }));
  $('#project-report').addEventListener('click', () => composeReport({ project_id: p.id, label: `مشروع: ${p.name}` }));
  const sendBtn = $('#send-project-reqs');
  if (sendBtn) {
    sendBtn.addEventListener('click', () => sendRequirementsModal(`/api/projects/${p.id}/requirements/send`,
      data.my_draft_requirements, () => viewProject(id)));
  }
  const addBtn = $('#add-member');
  if (addBtn) {
    addBtn.addEventListener('click', () => openModal({
      title: 'إضافة عضو للمشروع',
      body: `<div class="field"><label>العضو</label><select name="user_id">
        ${data.addable_users.map((u) => `<option value="${u.id}">${esc(u.name)} — ${esc(ROLE_LABELS[u.role])}</option>`).join('')}
      </select></div>`,
      submitLabel: 'إضافة',
      onSubmit: async (d) => {
        await api('POST', `/api/projects/${p.id}/members`, { user_id: Number(d.user_id) });
        viewProject(id);
      },
    }));
  }
  $$('[data-remove-member]', el).forEach((b) => b.addEventListener('click', () => confirmModal('إزالة العضو من المشروع؟', async () => {
    await api('DELETE', `/api/projects/${p.id}/members/${b.dataset.removeMember}`);
    viewProject(id);
  }, 'إزالة')));
  if (can.manage) {
    $('#edit-project').addEventListener('click', () => openModal({
      title: 'تعديل المشروع',
      body: `
        <div class="field"><label>الاسم</label><input name="name" value="${esc(p.name)}" required></div>
        <div class="field"><label>الوصف</label><textarea name="description">${esc(p.description)}</textarea></div>
        <div class="field"><label>الحالة</label><select name="status">
          ${Object.entries(PROJECT_STATUS).map(([k, [l]]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>`,
      onSubmit: async (d) => {
        await api('PATCH', `/api/projects/${p.id}`, d);
        viewProject(id);
      },
    }));
    $('#delete-project').addEventListener('click', () => confirmModal(
      'حذف المشروع هيمسح كل التاسكات والطلبات اللي فيه. متأكد؟', async () => {
        await api('DELETE', `/api/projects/${p.id}`);
        location.hash = '#/projects';
      }, 'حذف'));
  }
}

function sendRequirementsModal(path, count, after) {
  openModal({
    title: 'إرسال الطلبات',
    body: `<p>هيتم إرسال <strong>${count}</strong> طلب لـ <strong>${esc(state.me.supervisor_name)}</strong> (المسؤول المباشر عنك).</p>
      <div class="field"><label>ملاحظة (اختياري)</label><textarea name="note"></textarea></div>`,
    submitLabel: 'إرسال',
    onSubmit: async (d) => {
      const r = await api('POST', path, d);
      toast(`تم إرسال ${r.count} طلب`);
      after();
    },
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function taskFormModal({ projectId, task = null, assignable = null }) {
  if (!assignable) {
    const { users } = await api('GET', '/api/users');
    assignable = users.filter((u) => u.active && (u.id === state.me.id || u.manageable));
  }
  const t = task || { title: '', description: '', priority: 'medium', assignee_id: state.me.id, deadline: null, reminder_at: null };
  openModal({
    title: task ? 'تعديل التاسك' : 'تاسك جديدة',
    body: `
      <div class="field"><label>العنوان</label><input name="title" value="${esc(t.title)}" required></div>
      <div class="field"><label>الوصف</label><textarea name="description">${esc(t.description)}</textarea></div>
      <div class="row">
        <div class="field"><label>المسؤول</label><select name="assignee_id">
          ${assignable.map((u) => `<option value="${u.id}" ${u.id === t.assignee_id ? 'selected' : ''}>${esc(u.id === state.me.id ? `${u.name} (أنا)` : u.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>الأولوية</label><select name="priority">
          ${Object.entries(PRIORITY_LABELS).map(([k, l]) => `<option value="${k}" ${k === t.priority ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      </div>
      <div class="row">
        <div class="field"><label>الديدلاين</label><input type="datetime-local" name="deadline" value="${toLocalInput(t.deadline)}"></div>
        <div class="field"><label>⏰ التنبيه (الارم)</label><input type="datetime-local" name="reminder_at" value="${toLocalInput(t.reminder_at)}"></div>
      </div>`,
    submitLabel: task ? 'حفظ' : 'إنشاء',
    onSubmit: async (d) => {
      const body = {
        ...d,
        assignee_id: Number(d.assignee_id),
        deadline: fromLocalInput(d.deadline),
        reminder_at: fromLocalInput(d.reminder_at),
      };
      if (task) {
        await api('PATCH', `/api/tasks/${task.id}`, body);
        viewTask(task.id);
      } else {
        const r = await api('POST', `/api/projects/${projectId}/tasks`, body);
        location.hash = `#/tasks/${r.task.id}`;
      }
    },
  });
}

async function viewTasks() {
  const scope = sessionStorage.getItem('taskScope') || 'mine';
  const status = sessionStorage.getItem('taskStatus') || '';
  const hasTeam = state.me.role !== 'employee';
  const qs = new URLSearchParams({ scope: hasTeam ? scope : 'mine' });
  if (status) qs.set('status', status);
  const { tasks } = await api('GET', `/api/tasks?${qs}`);
  const el = render(`
    <div class="page-head"><h1>التاسكات</h1></div>
    ${hasTeam ? `<div class="tabs">
      <a href="#" data-scope="mine" class="${scope === 'mine' ? 'active' : ''}">تاسكاتي</a>
      <a href="#" data-scope="team" class="${scope === 'team' ? 'active' : ''}">تاسكات فريقي</a></div>` : ''}
    <div class="card">
      <div class="inline-form" style="margin-bottom:.6rem"><div class="field" style="max-width:220px">
        <label>الحالة</label><select id="status-filter"><option value="">الكل</option>
        ${Object.entries(STATUS_LABELS).map(([k, l]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div></div>
      ${taskRows(tasks, { showAssignee: hasTeam && scope === 'team' })}
    </div>`);
  bindRowLinks(el);
  $$('[data-scope]', el).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    sessionStorage.setItem('taskScope', a.dataset.scope);
    viewTasks();
  }));
  $('#status-filter').addEventListener('change', (e) => {
    sessionStorage.setItem('taskStatus', e.target.value);
    viewTasks();
  });
}

async function viewTask(id) {
  const data = await api('GET', `/api/tasks/${id}`);
  const { task: t, history, requirements, permissions: can } = data;
  const drafts = requirements.filter((r) => !r.request_id && r.requested_by === state.me.id);
  const sent = requirements.filter((r) => r.request_id);

  const el = render(`
    <div class="page-head">
      <div><div class="muted small"><a href="#/projects/${data.project.id}">📁 ${esc(data.project.name)}</a></div>
        <h1>${esc(t.title)}</h1></div>
      <div class="actions">
        <button class="btn ghost" id="task-report">📝 ريبورت عن التاسك</button>
        ${can.edit ? '<button class="btn ghost" id="edit-task">تعديل</button><button class="btn ghost" id="delete-task">حذف</button>' : ''}
      </div>
    </div>

    <div class="grid cols-2">
      <section class="card">
        <h2>التفاصيل</h2>
        <table class="list"><tbody>
          <tr><th>الحالة</th><td>${statusPill(t.status)}</td></tr>
          <tr><th>المسؤول</th><td>${esc(t.assignee_name)}</td></tr>
          <tr><th>أنشأها</th><td>${esc(t.creator_name)}</td></tr>
          <tr><th>الأولوية</th><td>${PRIORITY_LABELS[t.priority]}</td></tr>
          <tr><th>الديدلاين</th><td>${relDeadline(t.deadline, t.status)}</td></tr>
          <tr><th>⏰ التنبيه</th><td>${t.reminder_at ? `${esc(fmtDate(t.reminder_at))} ${t.reminder_sent ? '<span class="pill gray">اتبعت</span>' : ''}` : '<span class="muted">مفيش</span>'}
            ${can.set_reminder ? '<button class="btn small ghost" id="set-reminder">ضبط</button>' : ''}</td></tr>
        </tbody></table>
        ${t.description ? `<h3 style="margin-top:1rem">الوصف</h3><div class="pre">${esc(t.description)}</div>` : ''}
      </section>

      <section class="card">
        <h2>الحالة: واقفة فين وليه؟</h2>
        ${t.status_note ? `<div class="callout ${t.status === 'blocked' ? 'red' : 'blue'}">${statusPill(t.status)} ${esc(t.status_note)}</div>` : ''}
        ${can.update_status ? `<form id="status-form">
          <div class="field"><label>الحالة الجديدة</label><select name="status">
            ${Object.entries(STATUS_LABELS).map(([k, l]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
          <div class="field"><label>السبب / ملاحظة <span class="muted small">(إجباري لو متوقفة)</span></label>
            <textarea name="note" placeholder="مثلاً: مستني الديزاين من فريق UI"></textarea></div>
          <div class="form-error"></div>
          <button class="btn" type="submit">تحديث الحالة</button>
        </form>` : ''}
        <h3 style="margin-top:1rem">سجل الحالات</h3>
        <ul class="timeline">${history.map((h) => `<li>
          ${h.from_status ? `${statusPill(h.from_status)} ← ` : ''}${statusPill(h.to_status)}
          ${h.note ? `<div>${esc(h.note)}</div>` : ''}
          <div class="muted small">${esc(h.user_name)} · ${esc(fmtDate(h.created_at))}</div></li>`).join('')}</ul>
      </section>
    </div>

    <section class="card section" style="margin-top:1rem">
      <h2>📦 متطلبات التاسك</h2>
      ${can.add_requirements ? `
        <form class="inline-form" id="req-form">
          <div class="field" style="flex:3"><label>محتاج إيه؟</label><input name="description" placeholder="مثلاً: لابتوب، صلاحية على السيرفر، ..." required></div>
          <div class="field" style="flex:1"><label>الكمية</label><input name="quantity" placeholder="اختياري"></div>
          <button class="btn ghost" type="submit">+ إضافة</button>
        </form>
        <div class="list-items" style="margin-top:.6rem">${drafts.map((r) => `<div class="list-item">
          <div class="grow">${esc(r.description)} ${r.quantity ? `<span class="muted">× ${esc(r.quantity)}</span>` : ''}</div>
          ${pill(REQUEST_STATUS.draft)}
          <button class="btn small ghost" data-del-req="${r.id}">حذف</button></div>`).join('')}</div>
        <div class="send-bar">
          <div>عندك <strong>${drafts.length}</strong> طلب جاهز</div>
          <button class="btn" id="send-task-reqs" style="margin-inline-start:auto" ${drafts.length ? '' : 'disabled'}>
            إرسال طلبات التاسك لـ ${esc(state.me.supervisor_name || '')}</button>
        </div>` : '<p class="muted">مفيش مسؤول أعلى منك لطلب المتطلبات منه.</p>'}
      ${sent.length ? `<h3 style="margin-top:1rem">طلبات اتبعتت</h3>
        <div class="list-items">${sent.map((r) => `<div class="list-item">
          <div class="grow">${esc(r.description)} ${r.quantity ? `<span class="muted">× ${esc(r.quantity)}</span>` : ''}
            <div class="muted small">${esc(r.requested_by_name)} · ${esc(fmtDate(r.sent_at))}
            ${r.response_note ? ` · الرد: ${esc(r.response_note)}` : ''}</div></div>
          ${pill(REQUEST_STATUS[r.request_status])}
          <a class="btn small ghost" href="#/requests/${r.request_id}">عرض</a></div>`).join('')}</div>` : ''}
    </section>`);

  $('#task-report').addEventListener('click', () => composeReport({ task_id: t.id, label: `تاسك: ${t.title}` }));
  if (can.edit) {
    $('#edit-task').addEventListener('click', () => taskFormModal({ task: t, assignable: data.assignable_users }));
    $('#delete-task').addEventListener('click', () => confirmModal('حذف التاسك نهائياً؟', async () => {
      await api('DELETE', `/api/tasks/${t.id}`);
      location.hash = `#/projects/${data.project.id}`;
    }, 'حذف'));
  }
  const reminderBtn = $('#set-reminder');
  if (reminderBtn) {
    reminderBtn.addEventListener('click', () => openModal({
      title: '⏰ ضبط التنبيه',
      body: `<div class="field"><label>نبهني يوم</label><input type="datetime-local" name="reminder_at" value="${toLocalInput(t.reminder_at)}"></div>
        <p class="muted small">سيب الخانة فاضية لإلغاء التنبيه. التنبيه بيظهر بصوت ورسالة وانت فاتح النظام.</p>`,
      onSubmit: async (d) => {
        await api('PATCH', `/api/tasks/${t.id}`, { reminder_at: fromLocalInput(d.reminder_at) });
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        viewTask(t.id);
      },
    }));
  }
  const statusForm = $('#status-form');
  if (statusForm) {
    statusForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/tasks/${t.id}/status`, formData(statusForm));
        toast('تم تحديث الحالة');
        viewTask(t.id);
      } catch (err) {
        $('.form-error', statusForm).textContent = err.message;
      }
    });
  }
  const reqForm = $('#req-form');
  if (reqForm) {
    reqForm.addEventListener('submit', (e) => {
      e.preventDefault();
      attempt(async () => {
        await api('POST', `/api/tasks/${t.id}/requirements`, formData(reqForm));
        viewTask(t.id);
      });
    });
    $$('[data-del-req]', el).forEach((b) => b.addEventListener('click', () => attempt(async () => {
      await api('DELETE', `/api/requirements/${b.dataset.delReq}`);
      viewTask(t.id);
    })));
    $('#send-task-reqs').addEventListener('click', () => sendRequirementsModal(
      `/api/tasks/${t.id}/requirements/send`, drafts.length, () => viewTask(t.id)));
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function composeReport({ project_id = null, task_id = null, label = '' } = {}) {
  if (!state.me.supervisor_id) {
    toast('مفيش حد أعلى منك تبعتله ريبورت', true);
    return;
  }
  openModal({
    title: 'ريبورت جديد',
    body: `
      <p class="muted">إلى: <strong>${esc(state.me.supervisor_name)}</strong> (المسؤول المباشر عنك)${label ? ` · بخصوص ${esc(label)}` : ''}</p>
      <div class="field"><label>العنوان</label><input name="title" required></div>
      <div class="field"><label>المحتوى</label><textarea name="body" rows="8" required></textarea></div>`,
    submitLabel: 'إرسال',
    onSubmit: async (d) => {
      await api('POST', '/api/reports', { ...d, project_id, task_id });
      toast('تم إرسال الريبورت');
    },
  });
}

async function viewReports() {
  const box = sessionStorage.getItem('reportBox') || 'inbox';
  const { reports } = await api('GET', `/api/reports?box=${box}`);
  const el = render(`
    <div class="page-head"><h1>الريبورتات</h1>
      <div class="actions">${state.me.supervisor_id ? `<button class="btn" id="new-report">+ ريبورت لـ ${esc(state.me.supervisor_name)}</button>` : ''}</div></div>
    <div class="tabs">
      <a href="#" data-box="inbox" class="${box === 'inbox' ? 'active' : ''}">الوارد</a>
      <a href="#" data-box="sent" class="${box === 'sent' ? 'active' : ''}">المرسل</a>
    </div>
    <div class="card"><div class="list-items">
      ${reports.length ? reports.map((r) => `<div class="list-item clickable ${box === 'inbox' && !r.read_at ? 'unread' : ''}" data-href="#/reports/${r.id}">
        <div class="grow"><div class="title">${esc(r.title)}</div>
          <div class="muted small">${box === 'inbox' ? `من ${esc(r.sender_name)}` : `إلى ${esc(r.recipient_name)}`} · ${esc(fmtDate(r.created_at))}
          ${r.project_name ? ` · 📁 ${esc(r.project_name)}` : ''}${r.task_title ? ` · ✅ ${esc(r.task_title)}` : ''}</div></div>
        ${r.reply ? '<span class="pill green">تم الرد</span>' : ''}
        ${box === 'inbox' && !r.read_at ? '<span class="pill blue">جديد</span>' : ''}
      </div>`).join('') : '<div class="empty">لا توجد ريبورتات</div>'}
    </div></div>`);
  bindRowLinks(el);
  $$('[data-box]', el).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    sessionStorage.setItem('reportBox', a.dataset.box);
    viewReports();
  }));
  const btn = $('#new-report');
  if (btn) btn.addEventListener('click', () => composeReport());
}

async function viewReport(id) {
  const { report: r, forwarded_from: f, permissions: can } = await api('GET', `/api/reports/${id}`);
  render(`
    <div class="page-head"><a href="#/reports">→ الريبورتات</a></div>
    <article class="card">
      <h1>${esc(r.title)}</h1>
      <div class="meta">من ${esc(r.sender_name)} إلى ${esc(r.recipient_name)} · ${esc(fmtDate(r.created_at))}
        ${r.project_id ? `· <a href="#/projects/${r.project_id}">📁 ${esc(r.project_name)}</a>` : ''}
        ${r.task_id ? `· <a href="#/tasks/${r.task_id}">✅ ${esc(r.task_title)}</a>` : ''}</div>
      <div class="pre" style="margin-top:1rem">${esc(r.body)}</div>
      ${f ? `<div class="card" style="margin-top:1rem;background:var(--surface-2)">
        <div class="muted small">الريبورت الأصلي من ${esc(f.sender_name)} · ${esc(fmtDate(f.created_at))}</div>
        <h3>${esc(f.title)}</h3><div class="pre">${esc(f.body)}</div></div>` : ''}
      ${r.reply ? `<div class="callout blue" style="margin-top:1rem"><strong>الرد:</strong> <span class="pre">${esc(r.reply)}</span>
        <div class="small">${esc(fmtDate(r.replied_at))}</div></div>` : ''}
      <div style="display:flex;gap:.5rem;margin-top:1rem">
        ${can.reply ? '<button class="btn" id="reply">رد</button>' : ''}
        ${can.forward ? `<button class="btn ghost" id="forward">تحويل لـ ${esc(state.me.supervisor_name)}</button>` : ''}
      </div>
    </article>`);
  if (can.reply) {
    $('#reply').addEventListener('click', () => openModal({
      title: 'رد على الريبورت',
      body: '<div class="field"><label>الرد</label><textarea name="reply" required></textarea></div>',
      submitLabel: 'إرسال',
      onSubmit: async (d) => { await api('POST', `/api/reports/${r.id}/reply`, d); viewReport(id); },
    }));
  }
  if (can.forward) {
    $('#forward').addEventListener('click', () => openModal({
      title: `تحويل الريبورت لـ ${state.me.supervisor_name}`,
      body: '<div class="field"><label>تعليقك (اختياري)</label><textarea name="note"></textarea></div>',
      submitLabel: 'تحويل',
      onSubmit: async (d) => {
        const res = await api('POST', `/api/reports/${r.id}/forward`, d);
        toast('تم التحويل');
        location.hash = `#/reports/${res.report_id}`;
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Requests (requirement batches)
// ---------------------------------------------------------------------------

async function viewRequests() {
  const box = sessionStorage.getItem('requestBox') || 'inbox';
  const { requests } = await api('GET', `/api/requests?box=${box}`);
  const el = render(`
    <div class="page-head"><h1>الطلبات</h1></div>
    <p class="muted">الطلبات بتتضاف من صفحة كل تاسك، وتتبعت بضغطة زرار للتاسك أو للمشروع كله.</p>
    <div class="tabs">
      <a href="#" data-box="inbox" class="${box === 'inbox' ? 'active' : ''}">الوارد</a>
      <a href="#" data-box="sent" class="${box === 'sent' ? 'active' : ''}">المرسل</a>
    </div>
    <div class="card"><div class="list-items">
      ${requests.length ? requests.map((q) => `<div class="list-item clickable" data-href="#/requests/${q.id}">
        <div class="grow"><div class="title">${q.scope === 'project' ? `📁 كل طلبات مشروع ${esc(q.project_name)}` : `✅ ${esc(q.task_title)}`}
          <span class="muted small">(${q.items_count} طلب)</span></div>
          <div class="muted small">${box === 'inbox' ? `من ${esc(q.sender_name)}` : `إلى ${esc(q.recipient_name)}`} · ${esc(fmtDate(q.created_at))}
          ${q.forwarded_from_id ? ' · محوّل' : ''}</div></div>
        ${pill(REQUEST_STATUS[q.status])}
      </div>`).join('') : '<div class="empty">لا توجد طلبات</div>'}
    </div></div>`);
  bindRowLinks(el);
  $$('[data-box]', el).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    sessionStorage.setItem('requestBox', a.dataset.box);
    viewRequests();
  }));
}

async function viewRequest(id) {
  const { request: q, items, chain, permissions: can } = await api('GET', `/api/requests/${id}`);
  const byTask = {};
  for (const it of items) (byTask[it.task_title] = byTask[it.task_title] || []).push(it);
  render(`
    <div class="page-head"><a href="#/requests">→ الطلبات</a></div>
    <article class="card">
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
        <h1 style="margin:0">${q.scope === 'project' ? `طلبات مشروع ${esc(q.project_name)}` : `طلبات تاسك: ${esc(q.task_title)}`}</h1>
        ${pill(REQUEST_STATUS[q.status])}</div>
      <div class="meta" style="margin-top:.3rem">من ${esc(q.sender_name)} إلى ${esc(q.recipient_name)} · ${esc(fmtDate(q.created_at))}
        · <a href="#/projects/${q.project_id}">📁 ${esc(q.project_name)}</a></div>
      ${q.note ? `<div class="callout blue">${esc(q.note)}</div>` : ''}
      ${q.response_note ? `<div class="callout ${q.status === 'rejected' ? 'red' : 'blue'}"><strong>الرد:</strong> ${esc(q.response_note)}</div>` : ''}

      ${Object.entries(byTask).map(([title, list]) => `<h3 style="margin-top:1rem">✅ ${esc(title)}</h3>
        <ul>${list.map((it) => `<li>${esc(it.description)} ${it.quantity ? `<span class="muted">× ${esc(it.quantity)}</span>` : ''}</li>`).join('')}</ul>`).join('')}

      ${chain.length > 1 ? `<h3 style="margin-top:1rem">مسار الطلب</h3><ul class="timeline">${chain.map((c) => `<li>
        ${esc(c.sender_name)} ← ${esc(c.recipient_name)} ${pill(REQUEST_STATUS[c.status])}
        ${c.note ? `<div>${esc(c.note)}</div>` : ''}<div class="muted small">${esc(fmtDate(c.created_at))}</div></li>`).join('')}</ul>` : ''}

      <div style="display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap">
        ${can.respond ? '<button class="btn success" id="approve">موافقة</button><button class="btn danger" id="reject">رفض</button>' : ''}
        ${can.forward ? `<button class="btn ghost" id="forward">تحويل لـ ${esc(state.me.supervisor_name)}</button>` : ''}
      </div>
    </article>`);
  const respond = (decision) => openModal({
    title: decision === 'approved' ? 'الموافقة على الطلب' : 'رفض الطلب',
    body: `<div class="field"><label>${decision === 'approved' ? 'ملاحظة (اختياري)' : 'سبب الرفض'}</label><textarea name="note"></textarea></div>`,
    submitLabel: decision === 'approved' ? 'موافقة' : 'رفض',
    danger: decision === 'rejected',
    onSubmit: async (d) => { await api('POST', `/api/requests/${q.id}/respond`, { ...d, decision }); viewRequest(id); },
  });
  if (can.respond) {
    $('#approve').addEventListener('click', () => respond('approved'));
    $('#reject').addEventListener('click', () => respond('rejected'));
  }
  if (can.forward) {
    $('#forward').addEventListener('click', () => openModal({
      title: `تحويل الطلب لـ ${state.me.supervisor_name}`,
      body: '<div class="field"><label>ملاحظة (اختياري)</label><textarea name="note"></textarea></div>',
      submitLabel: 'تحويل',
      onSubmit: async (d) => {
        await api('POST', `/api/requests/${q.id}/forward`, d);
        toast('تم التحويل');
        viewRequest(id);
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

async function viewTeam() {
  const { users } = await api('GET', '/api/users');
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const children = {};
  const roots = [];
  for (const u of users) {
    if (u.supervisor_id && byId[u.supervisor_id]) (children[u.supervisor_id] = children[u.supervisor_id] || []).push(u);
    else roots.push(u);
  }
  const node = (u) => `<li><span class="node ${u.active ? '' : 'inactive'}">
      <strong>${esc(u.name)}</strong> <span class="pill gray">${esc(ROLE_LABELS[u.role])}</span>
      ${u.id === state.me.id ? '<span class="pill blue">أنا</span>' : ''}
      ${u.active ? '' : '<span class="pill red">موقوف</span>'}
      <span class="muted small">${esc(u.email)}</span>
      ${u.manageable ? `<button class="btn small ghost" data-manage="${u.id}">إدارة</button>` : ''}
    </span>${children[u.id] ? `<ul>${children[u.id].map(node).join('')}</ul>` : ''}</li>`;
  const canAdd = state.me.role !== 'employee';
  const el = render(`
    <div class="page-head"><h1>الفريق</h1>
      <div class="actions">${canAdd ? '<button class="btn" id="add-user">+ إضافة شخص</button>' : ''}</div></div>
    <p class="muted">كل شخص بيبعت ريبورتاته وطلباته للي فوقه مباشرة بس.</p>
    <div class="card tree"><ul>${roots.map(node).join('')}</ul></div>`);

  if (canAdd) {
    $('#add-user').addEventListener('click', () => {
      const myRank = ROLES.indexOf(state.me.role);
      const roles = ROLES.slice(myRank + 1);
      const candidates = users.filter((u) => u.active && (u.id === state.me.id || u.manageable));
      const supervisorOptions = (role) => candidates
        .filter((u) => ROLES.indexOf(u.role) === ROLES.indexOf(role) - 1)
        .map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(ROLE_LABELS[u.role])})</option>`).join('');
      const { el: modal } = openModal({
        title: 'إضافة شخص',
        body: `
          <div class="field"><label>الاسم</label><input name="name" required></div>
          <div class="field"><label>البريد الإلكتروني</label><input name="email" type="email" required></div>
          <div class="field"><label>كلمة مرور مبدئية</label><input name="password" type="text" required minlength="6"></div>
          <div class="row">
            <div class="field"><label>الدور</label><select name="role">
              ${roles.map((r) => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join('')}</select></div>
            <div class="field"><label>المسؤول المباشر</label><select name="supervisor_id">${supervisorOptions(roles[0])}</select></div>
          </div>`,
        submitLabel: 'إضافة',
        onSubmit: async (d) => {
          await api('POST', '/api/users', { ...d, supervisor_id: Number(d.supervisor_id) || undefined });
          toast('تمت الإضافة');
          viewTeam();
        },
      });
      $('[name=role]', modal).addEventListener('change', (e) => {
        $('[name=supervisor_id]', modal).innerHTML = supervisorOptions(e.target.value);
      });
    });
  }

  $$('[data-manage]', el).forEach((b) => b.addEventListener('click', () => {
    const u = byId[b.dataset.manage];
    openModal({
      title: `إدارة ${u.name}`,
      body: `
        <div class="field"><label>الاسم</label><input name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label>كلمة مرور جديدة <span class="muted small">(سيبها فاضية لو مش عايز تغيرها)</span></label>
          <input name="password" type="text"></div>
        <div class="checks"><label><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> الحساب نشط</label></div>`,
      onSubmit: async (d) => {
        const body = { name: d.name, active: d.active };
        if (d.password) body.password = d.password;
        await api('PATCH', `/api/users/${u.id}`, body);
        toast('تم الحفظ');
        viewTeam();
      },
    });
  }));
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function viewNotifications() {
  const { notifications } = await api('GET', '/api/notifications');
  const canAsk = 'Notification' in window && Notification.permission === 'default';
  const el = render(`
    <div class="page-head"><h1>الإشعارات</h1>
      <div class="actions">
        ${canAsk ? '<button class="btn ghost" id="enable-push">🔔 تفعيل تنبيهات المتصفح</button>' : ''}
        <button class="btn ghost" id="read-all">تعليم الكل كمقروء</button>
      </div></div>
    <div class="card"><div class="list-items">
      ${notifications.length ? notifications.map((n) => `<div class="list-item clickable ${n.read_at ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link)}">
        <div class="grow"><div class="title">${esc(n.message)}</div><div class="muted small">${esc(fmtDate(n.created_at))}</div></div>
        ${n.read_at ? '' : '<span class="pill blue">جديد</span>'}</div>`).join('') : '<div class="empty">لا توجد إشعارات</div>'}
    </div></div>`);
  $('#read-all').addEventListener('click', () => attempt(async () => {
    await api('POST', '/api/notifications/read-all', {});
    pollNotifications();
    viewNotifications();
  }));
  const push = $('#enable-push');
  if (push) push.addEventListener('click', async () => { await Notification.requestPermission(); viewNotifications(); });
  $$('[data-id]', el).forEach((item) => item.addEventListener('click', async () => {
    await api('POST', `/api/notifications/${item.dataset.id}/read`, {}).catch(() => {});
    pollNotifications();
    if (item.dataset.link) location.hash = item.dataset.link;
    else viewNotifications();
  }));
}

boot();
