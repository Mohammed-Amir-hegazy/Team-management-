// Entry point: session, shell (sidebar / tab bar), router, notification polling and alarms.

import {
  state, $, $$, esc, icon, mark, api, toast, openModal, formData, avatar, loader, setFab,
  ROLE_LABELS, fmtLongDate,
} from './core.js';
import { viewDashboard } from './views/dashboard.js';
import { viewProjects, viewProject } from './views/projects.js';
import { viewTasks, viewTask } from './views/tasks.js';
import { viewReports, viewReport } from './views/reports.js';
import { viewRequests, viewRequest } from './views/requests.js';
import { viewTeam } from './views/team.js';
import { viewPeople } from './views/people.js';
import { viewNotifications } from './views/notifications.js';

const ALARM_TYPES = new Set(['reminder', 'overdue']);

// ---------------------------------------------------------------------------
// Boot & authentication
// ---------------------------------------------------------------------------

async function boot() {
  const minSplash = new Promise((r) => setTimeout(r, 900));
  try {
    const { user } = await api('GET', '/api/me');
    state.me = user;
    await minSplash;
    showApp();
  } catch {
    await minSplash;
    await showAuth();
  }
  $('#splash').classList.add('gone');
}

async function showAuth() {
  stopPolling();
  $('#shell').classList.add('hidden');
  const el = $('#auth');
  el.classList.remove('hidden');
  let needsSetup = false;
  try {
    ({ needsSetup } = await api('GET', '/api/setup-status'));
  } catch (err) {
    toast(err.message, { error: true });
  }
  el.innerHTML = `
    <section class="auth-brand">
      <span class="blob a"></span><span class="blob b"></span>
      <div>
        <div class="auth-logo"><img src="/brand/wordmark-white.svg" alt="EBTIKAR">${mark('animate')}</div>
        <h2>منصة ابتكار لإدارة الأعمال</h2>
        <p>مشاريعك ومهامك وتقارير فريقك في مكان واحد، بتسلسل إداري واضح ومتابعة لحظية لحالة العمل.</p>
        <ul class="auth-points">
          <li><span class="dot">${icon('layers')}</span>مشاريع ومهام بمواعيد نهائية وتنبيهات</li>
          <li><span class="dot">${icon('report')}</span>تقارير ترفع حالة العمل كاملة بضغطة زر</li>
          <li><span class="dot">${icon('shield')}</span>تسلسل إداري يحترم الصلاحيات</li>
        </ul>
      </div>
      <div class="small" style="color:#8D8AC9">© ${new Date().getFullYear()} Ebtikar Software Solutions</div>
    </section>
    <section class="auth-form">
      <div class="card">
        <h1>${needsSetup ? 'إعداد النظام' : 'تسجيل الدخول'}</h1>
        <p class="muted">${needsSetup ? 'أنشئ حساب صاحب الشركة للبدء في استخدام المنصة.' : 'مرحبًا بعودتك، يُرجى إدخال بيانات حسابك.'}</p>
        <form id="auth-form" novalidate>
          ${needsSetup ? `
            <div class="field"><label for="f-name">الاسم الكامل</label><input id="f-name" name="name" required autocomplete="name"></div>
            <div class="field"><label for="f-title">المسمى الوظيفي <span class="hint">(اختياري)</span></label><input id="f-title" name="job_title" placeholder="مثال: المدير التنفيذي"></div>` : ''}
          <div class="field"><label for="f-email">البريد الإلكتروني</label>
            <div class="input-icon">${icon('user')}<input id="f-email" name="email" type="email" required autocomplete="username" dir="ltr"></div></div>
          <div class="field"><label for="f-pass">كلمة المرور</label>
            <div class="input-icon">${icon('key')}<input id="f-pass" name="password" type="password" required dir="ltr"
              autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
              <button type="button" class="toggle-pass" aria-label="إظهار كلمة المرور">${icon('eye')}</button></div></div>
          <div class="form-error" role="alert"></div>
          <button class="btn lg block" type="submit">${needsSetup ? 'إنشاء الحساب والبدء' : 'دخول'}</button>
        </form>
        <div class="auth-copy">${fmtLongDate()}</div>
      </div>
    </section>`;
  $('.toggle-pass', el).addEventListener('click', (e) => {
    const input = $('#f-pass');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
  });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const { user } = await api('POST', needsSetup ? '/api/setup' : '/api/login', formData(e.target));
      state.me = user;
      const me = await api('GET', '/api/me');
      state.me = me.user;
      showApp();
    } catch (err) {
      $('.form-error', e.target).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

window.addEventListener('session-expired', () => {
  state.me = null;
  showAuth();
});

async function logout() {
  await api('POST', '/api/logout', {}).catch(() => {});
  state.me = null;
  location.hash = '';
  showAuth();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function navItems() {
  const me = state.me;
  return [
    ['dashboard', 'الرئيسية', 'home'],
    ['projects', 'المشاريع', 'folder'],
    ['tasks', 'المهام', 'tasks'],
    ['reports', 'التقارير', 'report', 'reports'],
    ['requests', 'الطلبات', 'box', 'requests'],
    me.has_team ? ['team', 'متابعة الفريق', 'chart'] : null,
    ['people', me.is_admin ? 'الموظفون والحسابات' : 'الهيكل الوظيفي', 'users'],
    ['notifications', 'الإشعارات', 'bell', 'notifications'],
  ].filter(Boolean);
}

function showApp() {
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  const me = state.me;

  $('#side-nav').innerHTML = navItems().map(([key, label, ic, badge]) =>
    `<a href="#/${key}" data-nav="${key}">${icon(ic)}<span>${label}</span>${badge ? `<span class="count hidden" data-count-for="${badge}"></span>` : ''}</a>`).join('');
  $('#side-user').innerHTML = `${avatar(me.name, me.id)}
    <div class="grow"><div class="name">${esc(me.name)}</div><div class="title">${esc(me.job_title || ROLE_LABELS[me.role])}</div></div>${icon('more')}`;
  $('#side-user').onclick = accountSheet;
  $('#bell').innerHTML = `${icon('bell')}<span class="dot hidden" id="bell-dot"></span>`;

  $('#tabbar').innerHTML = [
    ['dashboard', 'الرئيسية', 'home'],
    ['tasks', 'المهام', 'tasks'],
    ['projects', 'المشاريع', 'folder'],
    ['reports', 'التقارير', 'report', 'reports'],
  ].map(([key, label, ic, badge]) => `<a href="#/${key}" data-nav="${key}">${icon(ic)}<span>${label}</span>${
    badge ? `<span class="count hidden" data-count-for="${badge}"></span>` : ''}</a>`).join('')
    + `<button type="button" id="more-btn">${icon('more')}<span>المزيد</span><span class="count hidden" data-count-for="more"></span></button>`;
  $('#more-btn').onclick = moreSheet;

  try {
    state.lastNotificationId = Number(localStorage.getItem(`alarmSeen:${me.id}`)) || 0;
  } catch {
    state.lastNotificationId = 0;
  }
  if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
  route();
  startPolling();
}

function sheetItem(href, label, ic, extra = '') {
  return `<a class="item link" href="${href}" data-close>${icon(ic)}<span class="grow">${label}</span>${extra}</a>`;
}

function moreSheet() {
  const c = state.counts;
  const badge = (n) => (n ? `<span class="pill red plain">${n}</span>` : '');
  openModal({
    title: 'المزيد',
    className: 'menu-sheet',
    body: `<div class="list">
      ${sheetItem('#/requests', 'الطلبات', 'box', badge(c.requests))}
      ${state.me.has_team ? sheetItem('#/team', 'متابعة الفريق وتقرير الأداء', 'chart') : ''}
      ${sheetItem('#/people', state.me.is_admin ? 'الموظفون والحسابات' : 'الهيكل الوظيفي', 'users')}
      ${sheetItem('#/notifications', 'الإشعارات', 'bell', badge(c.notifications))}
      <a class="item link" href="#" data-account>${icon('user')}<span class="grow">حسابي</span></a>
      <a class="item link" href="#" data-logout>${icon('logout')}<span class="grow">تسجيل الخروج</span></a>
    </div>`,
  }).el.addEventListener('click', (e) => {
    if (e.target.closest('[data-account]')) { e.preventDefault(); e.target.closest('.modal-backdrop').remove(); accountSheet(); }
    if (e.target.closest('[data-logout]')) { e.preventDefault(); e.target.closest('.modal-backdrop').remove(); logout(); }
  });
}

function accountSheet() {
  const me = state.me;
  const { el } = openModal({
    title: 'حسابي',
    body: `
      <div class="row" style="margin-bottom:1rem">${avatar(me.name, me.id, 'lg')}
        <div class="grow"><h3 style="margin:0">${esc(me.name)}</h3>
          <div class="muted">${esc(me.job_title || ROLE_LABELS[me.role])}</div>
          <div class="row wrap" style="gap:.3rem;margin-top:.35rem">${me.roles.map((r) => `<span class="pill blue plain">${ROLE_LABELS[r]}</span>`).join('')}</div>
        </div></div>
      <div class="list" style="margin-bottom:1rem">
        <div class="item">${icon('user')}<span class="grow">البريد الإلكتروني</span><span class="muted" dir="ltr">${esc(me.email)}</span></div>
        <div class="item">${icon('users')}<span class="grow">المسؤول المباشر</span><span class="muted">${esc(me.supervisor_name || '—')}</span></div>
      </div>
      <h3>تغيير كلمة المرور</h3>
      <div class="field"><label>كلمة المرور الحالية</label><input type="password" name="current_password" dir="ltr" autocomplete="current-password"></div>
      <div class="field"><label>كلمة المرور الجديدة</label><input type="password" name="new_password" dir="ltr" autocomplete="new-password"></div>
      <div class="row" style="gap:.5rem"><button class="btn" type="submit">حفظ كلمة المرور</button>
        <button class="btn ghost" type="button" data-logout>${icon('logout')}تسجيل الخروج</button></div>`,
    onSubmit: async (d) => {
      await api('POST', '/api/me/password', d);
      toast('تم تغيير كلمة المرور بنجاح');
    },
    footer: false,
  });
  $('[data-logout]', el).addEventListener('click', () => { el.remove(); logout(); });
}

const topbar = $('#topbar');
window.addEventListener('scroll', () => topbar.classList.toggle('scrolled', window.scrollY > 4), { passive: true });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = {
  dashboard: viewDashboard,
  projects: (p) => (p.id ? viewProject(p) : viewProjects(p)),
  tasks: (p) => (p.id ? viewTask(p) : viewTasks(p)),
  reports: (p) => (p.id ? viewReport(p) : viewReports(p)),
  requests: (p) => (p.id ? viewRequest(p) : viewRequests(p)),
  team: viewTeam,
  people: viewPeople,
  notifications: viewNotifications,
};

export async function route() {
  if (!state.me) return;
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = path.split('/');
  const key = routes[name] ? name : 'dashboard';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  $$('.modal-backdrop').forEach((m) => m.remove());
  setFab(null);
  const view = $('#view');
  view.innerHTML = loader();
  window.scrollTo(0, 0);
  try {
    await routes[key]({ id, query: new URLSearchParams(qs) });
  } catch (err) {
    view.innerHTML = `<div class="card">${`<div class="empty">${mark()}<h3>تعذّر عرض الصفحة</h3><p>${esc(err.message)}</p>
      <a class="btn subtle" href="#/dashboard">العودة إلى الرئيسية</a></div>`}</div>`;
  }
  pollNotifications();
}
window.addEventListener('hashchange', route);
window.addEventListener('refresh-view', route);

// ---------------------------------------------------------------------------
// Notifications polling, badges and the alarm
// ---------------------------------------------------------------------------

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollNotifications, 30000);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function setCount(name, n) {
  state.counts[name] = n;
  $$(`[data-count-for="${name}"]`).forEach((el) => {
    el.textContent = n > 99 ? '99+' : n;
    el.classList.toggle('hidden', !n);
  });
}

async function pollNotifications() {
  if (!state.me) return;
  try {
    const data = await api('GET', '/api/notifications');
    setCount('notifications', data.unread);
    setCount('reports', data.unread_reports);
    setCount('requests', data.pending_requests);
    setCount('more', data.unread + data.pending_requests);
    const dot = $('#bell-dot');
    if (dot) dot.classList.toggle('hidden', !data.unread);

    const fresh = data.notifications.filter((n) => n.id > state.lastNotificationId);
    const firstVisit = state.lastNotificationId === 0;
    if (!fresh.length) return;
    state.lastNotificationId = Math.max(...fresh.map((n) => n.id));
    try { localStorage.setItem(`alarmSeen:${state.me.id}`, state.lastNotificationId); } catch { /* ignore */ }
    const unread = fresh.filter((n) => !n.read_at);
    if (!firstVisit && unread.length) {
      const bell = $('#bell');
      bell.classList.remove('ringing');
      void bell.offsetWidth;
      bell.classList.add('ringing');
      for (const n of unread) browserNotify(n);
    }
    const alarms = unread.filter((n) => ALARM_TYPES.has(n.type));
    if (alarms.length) showAlarm(alarms);
  } catch { /* offline: try again on the next tick */ }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.22, 0.44].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = [784, 988, 1175][i];
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.35);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.4);
    });
    if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
  } catch { /* audio not available */ }
}

function browserNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const note = new Notification('ابتكار', { body: n.message, tag: `n${n.id}`, icon: '/icon-192.png' });
    note.onclick = () => { window.focus(); if (n.link) location.hash = n.link; };
  } catch { /* some mobile browsers only allow notifications from a service worker */ }
}

function showAlarm(alarms) {
  beep();
  const { el, close } = openModal({
    title: 'تنبيه',
    className: 'alarm',
    body: `<div class="bell-big">${icon('bell')}</div>
      <div class="list" style="text-align:start">${alarms.map((n) => `
        <div class="item"><div class="grow">${esc(n.message)}</div>
        ${n.link ? `<a class="btn sm subtle" href="${esc(n.link)}" data-open="${n.id}">فتح</a>` : ''}</div>`).join('')}</div>
      <div class="modal-actions" style="justify-content:center;margin-top:.8rem">
        <button class="btn accent" type="button" data-ack>تم الاطلاع</button></div>`,
  });
  const markRead = (ids) => ids.forEach((id) => api('POST', `/api/notifications/${id}/read`, {}).catch(() => {}));
  el.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { markRead([open.dataset.open]); close(); }
    if (e.target.closest('[data-ack]')) { markRead(alarms.map((n) => n.id)); close(); }
  });
}

boot();
