// Entry point: session, shell (sidebar / tab bar), router, notification polling and alarms.

import {
  state, $, $$, esc, icon, mark, api, toast, openModal, formData, avatar, loader, setFab,
  ROLE_LABELS, busy, creatorFields, bindCreatorFields, rememberPhotos,
} from './core.js';
import { viewDashboard } from './views/dashboard.js';
import { viewProjects, viewProject } from './views/projects.js';
import { viewTasks, viewTask } from './views/tasks.js';
import { viewReports, viewReport } from './views/reports.js';
import { viewRequests, viewRequest } from './views/requests.js';
import { viewTeam } from './views/team.js';
import { viewPeople } from './views/people.js';
import { viewNotifications } from './views/notifications.js';
import { viewPlatform, viewCompany } from './views/platform.js';
import { viewSubscription, subscriptionBanner } from './views/subscription.js';
import { themeButton, themeSwitch } from './theme.js';
import { viewBrand } from './views/brand.js';

const ALARM_TYPES = new Set(['reminder', 'overdue', 'nudge', 'subscription']);

// ---------------------------------------------------------------------------
// Boot & authentication
// ---------------------------------------------------------------------------

async function boot() {
  const minSplash = new Promise((r) => setTimeout(r, 900));
  try {
    state.config = await api('GET', '/api/client-config');
  } catch { /* defaults: optional features hidden */ }
  try {
    const { user } = await api('GET', '/api/me');
    state.me = user;
    await loadPhotos();
    await minSplash;
    showApp();
  } catch {
    await minSplash;
    await showAuth();
  }
  $('#splash').classList.add('gone');
}

const passwordField = (id, name, autocomplete, label = 'كلمة المرور') => `
  <div class="field"><label for="${id}">${label}</label>
    <div class="input-icon">${icon('key')}<input id="${id}" name="${name}" type="password" required dir="ltr" autocomplete="${autocomplete}">
      <button type="button" class="toggle-pass" aria-label="إظهار كلمة المرور">${icon('eye')}</button></div></div>`;

function bindPasswordToggles(root) {
  root.querySelectorAll('.toggle-pass').forEach((btn) => btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = icon(show ? 'eyeOff' : 'eye');
  }));
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
    ${themeButton('auth-theme')}
    <span class="blob a"></span><span class="blob b"></span>
    <div class="auth-card card">
      <div class="auth-logo">${mark('animate')}<img class="only-light" src="/brand/wordmark-navy.svg" alt="EBTIKAR"><img class="only-dark" src="/brand/wordmark-white.svg" alt=""></div>
      <h1>${needsSetup ? 'إعداد النظام' : 'تسجيل الدخول'}</h1>
      ${needsSetup ? '<p class="muted small">إعداد الشركة الأولى على المنصة؛ يمكن أن يكون مُنشئ الحساب صاحب الشركة أو مسؤول النظام فيها.</p>' : ''}
      <form id="auth-form" novalidate>
        ${needsSetup ? `
          <div class="field"><label for="f-company">اسم الشركة</label><input id="f-company" name="company_name" value="ابتكار" required></div>
          <div class="field"><label for="f-name">الاسم الكامل</label><input id="f-name" name="name" required autocomplete="name"></div>
          <div class="fields">
            <div class="field"><label for="f-title">المسمى الوظيفي</label><input id="f-title" name="job_title" placeholder="مثال: المدير التنفيذي"></div>
            <div class="field"><label for="f-phone">رقم واتساب</label><input id="f-phone" name="phone" type="tel" dir="ltr" placeholder="2010xxxxxxxx+"></div>
          </div>
          ${creatorFields('f')}` : ''}
        <div class="field"><label for="f-email">البريد الإلكتروني</label>
          <div class="input-icon">${icon('user')}<input id="f-email" name="email" type="email" required autocomplete="username" dir="ltr"></div></div>
        ${passwordField('f-pass', 'password', needsSetup ? 'new-password' : 'current-password')}
        ${needsSetup ? '' : '<div class="auth-links"><a href="#" id="forgot">نسيت كلمة المرور؟</a></div>'}
        <div class="form-error" role="alert"></div>
        <button class="btn lg block" type="submit">${needsSetup ? 'إنشاء الحساب' : 'دخول'}</button>
      </form>
      ${!needsSetup && state.config.signup ? `<div class="signup-cta"><span class="muted">شركة جديدة؟</span>
        <a href="#" id="signup">ابدأ تجربة مجانية لمدة ${state.config.trial_days === 30 ? 'شهر' : `${state.config.trial_days} يومًا`}</a></div>` : ''}
    </div>
    <div class="auth-copy">© ${new Date().getFullYear()} Ebtikar Software Solutions</div>`;
  bindPasswordToggles(el);
  if (needsSetup) bindCreatorFields(el);
  const signup = $('#signup', el);
  if (signup) signup.addEventListener('click', (e) => { e.preventDefault(); showSignup(); });
  const forgot = $('#forgot', el);
  if (forgot) forgot.addEventListener('click', (e) => { e.preventDefault(); forgotPassword($('#f-email').value); });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const r = await api('POST', needsSetup ? '/api/setup' : '/api/login', formData(e.target));
      if (r.two_factor) { showLoginCode(r); return; }
      await enterApp();
      if (r.two_factor_unavailable) {
        toast('تنبيه: التحقق بخطوتين لحساب مالك المنصة غير مفعّل لعدم إعداد خدمة الرسائل', { error: true });
      }
    } catch (err) {
      $('.form-error', e.target).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// A new company registers and starts its free trial.
function showSignup() {
  const card = $('#auth .auth-card');
  card.innerHTML = `
    <div class="auth-logo">${mark('animate')}<img class="only-light" src="/brand/wordmark-navy.svg" alt="EBTIKAR"><img class="only-dark" src="/brand/wordmark-white.svg" alt=""></div>
    <h1>تسجيل شركة جديدة</h1>
    <p class="muted small">تجربة مجانية كاملة المزايا لمدة ${state.config.trial_days || 30} يومًا، دون الحاجة إلى وسيلة دفع.</p>
    <form id="signup-form" novalidate>
      <div class="field"><label>اسم الشركة</label><input name="company_name" required></div>
      <div class="fields">
        <div class="field"><label>اسمك الكامل</label><input name="name" required autocomplete="name"></div>
        <div class="field"><label>المسمى الوظيفي</label><input name="job_title" placeholder="مثال: المدير العام"></div>
      </div>
      <div class="field"><label>رقم واتساب</label><input name="phone" type="tel" dir="ltr" placeholder="2010xxxxxxxx+"></div>
      ${creatorFields('s')}
      <div class="field"><label>البريد الإلكتروني</label><div class="input-icon">${icon('user')}<input name="email" type="email" required dir="ltr" autocomplete="username"></div></div>
      ${passwordField('s-pass', 'password', 'new-password')}
      <div class="form-error" role="alert"></div>
      <button class="btn lg block accent" type="submit">إنشاء حساب الشركة وبدء التجربة</button>
    </form>
    <div class="signup-cta"><a href="#" id="back-login">لديك حساب بالفعل؟ تسجيل الدخول</a></div>`;
  bindPasswordToggles(card);
  bindCreatorFields(card);
  $('#back-login', card).addEventListener('click', (e) => { e.preventDefault(); showAuth(); });
  $('#signup-form', card).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      await api('POST', '/api/signup', formData(e.target));
      await enterApp();
      toast('مرحبًا بكم في منصة ابتكار؛ بدأت الفترة التجريبية');
    } catch (err) {
      $('.form-error', e.target).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

const CODE_CHANNELS = { whatsapp: ['واتساب', 'whatsapp'], sms: ['رسالة نصية SMS', 'phone'], email: ['البريد الإلكتروني', 'user'] };

// Second step for the platform owner: the code sent to their phone or email.
function showLoginCode(challenge) {
  const card = $('#auth .auth-card');
  let current = challenge;
  const draw = () => {
    const [label, ic] = CODE_CHANNELS[current.channel];
    card.innerHTML = `
      <div class="auth-logo">${mark('animate')}<img class="only-light" src="/brand/wordmark-navy.svg" alt="EBTIKAR"><img class="only-dark" src="/brand/wordmark-white.svg" alt=""></div>
      <h1>التحقق من هوية مالك المنصة</h1>
      <div class="callout green">${icon(ic)}<div>أُرسل رمز الدخول عبر ${label} إلى <bdi dir="ltr">${esc(current.destination)}</bdi></div></div>
      <form id="code-form" novalidate>
        <div class="field"><label for="f-code">رمز الدخول</label>
          <input id="f-code" class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" required placeholder="••••••"></div>
        <div class="form-error" role="alert"></div>
        <button class="btn lg block" type="submit">تأكيد الدخول</button>
      </form>
      <div class="auth-links code-links">
        <button type="button" class="link-btn" id="resend" disabled></button>
        ${current.channels.filter((c) => c !== current.channel).map((c) => `<button type="button" class="link-btn" data-channel="${c}">
          ${icon(CODE_CHANNELS[c][1])}الإرسال عبر ${CODE_CHANNELS[c][0]}</button>`).join('')}
      </div>
      <div class="signup-cta"><a href="#" id="back-login">العودة إلى تسجيل الدخول</a></div>`;
    const form = $('#code-form', card);
    const showError = (msg) => { $('.form-error', form).textContent = msg; };
    form.elements.code.focus();
    $('#back-login', card).addEventListener('click', (e) => { e.preventDefault(); showAuth(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      try {
        await api('POST', '/api/login/verify', { challenge: current.challenge, code: form.elements.code.value });
        await enterApp();
      } catch (err) {
        showError(err.message);
        if (/من جديد/.test(err.message)) setTimeout(() => showAuth(), 2500);
      } finally {
        if (btn.isConnected) btn.disabled = false;
      }
    });
    // Resending (on the same or another channel) is allowed once a minute.
    const links = $$('.code-links button', card);
    const resend = $('#resend', card);
    let left = 60;
    const tick = () => {
      if (!resend.isConnected) return;
      links.forEach((b) => { b.disabled = left > 0; });
      resend.textContent = left > 0 ? `إعادة الإرسال بعد ${left} ثانية` : 'إعادة إرسال الرمز';
      if (left-- > 0) setTimeout(tick, 1000);
    };
    tick();
    links.forEach((b) => b.addEventListener('click', async () => {
      try {
        current = await api('POST', '/api/login/resend', { challenge: current.challenge, channel: b.dataset.channel || current.channel });
        toast('تم إرسال رمز جديد');
        draw();
      } catch (err) {
        showError(err.message);
      }
    }));
  };
  draw();
}

async function enterApp() {
  const { user } = await api('GET', '/api/me');
  state.me = user;
  await loadPhotos();
  showApp();
}

// Profile photos of the people I can see, so every avatar can show one.
async function loadPhotos() {
  rememberPhotos([state.me]);
  try {
    rememberPhotos((await api('GET', '/api/users')).users);
  } catch { /* initials until the people list can be read */ }
}

// A square crop from the middle of the picture, small enough for an avatar.
async function squarePhoto(file, size = 360) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size, side);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
}

// Two steps in one sheet: ask for a code (email / SMS / WhatsApp), then set a new password with it.
function forgotPassword(prefill = '') {
  const channels = [['email', 'البريد الإلكتروني', 'user'], ['whatsapp', 'واتساب', 'whatsapp'], ['sms', 'رسالة نصية SMS', 'phone']]
    .filter(([k]) => state.config.otp[k]);
  const { el, form, close } = openModal({ title: 'استعادة كلمة المرور', footer: false, body: '<div id="fp"></div>' });
  const box = $('#fp', el);
  const showError = (msg) => { $('.form-error', form).textContent = msg; };
  let identifier = prefill;
  let channel = null;
  let handler = null;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!handler) return;
    const btn = $('button[type=submit]', box);
    if (btn) btn.disabled = true;
    showError('');
    try {
      await handler(formData(form));
    } catch (err) {
      showError(err.message);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });

  const stepOne = () => {
    if (!channels.length) {
      box.innerHTML = `<div class="callout amber">${icon('alert')}<div>استعادة كلمة المرور غير مفعّلة حاليًا. يُرجى التواصل مع مسؤول النظام لإعادة تعيينها.</div></div>`;
      return;
    }
    box.innerHTML = `
      <p class="muted">أدخل بريدك الإلكتروني أو رقم هاتفك المسجّل، واختر طريقة استلام رمز التحقق.</p>
      <div class="field"><label>البريد الإلكتروني أو رقم الهاتف</label>
        <input name="identifier" dir="ltr" required value="${esc(identifier)}" autocomplete="username"></div>
      <div class="field"><label>طريقة الاستلام</label><div class="checks cols">
        ${channels.map(([k, label, ic], i) => `<label class="check"><input type="radio" name="channel" value="${k}" ${i === 0 ? 'checked' : ''}>
          ${icon(ic)}<span class="grow">${label}</span></label>`).join('')}</div></div>
      <button class="btn block" type="submit">${icon('send')}إرسال رمز التحقق</button>`;
    handler = async (d) => {
      identifier = (d.identifier || '').trim();
      channel = d.channel;
      const r = await api('POST', '/api/password/forgot', { identifier, channel });
      stepTwo(r.message);
    };
  };

  const stepTwo = (message) => {
    box.innerHTML = `
      <div class="callout green">${icon('check')}<div>${esc(message)}</div></div>
      <div class="field"><label>رمز التحقق</label>
        <input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" required placeholder="••••••"></div>
      ${passwordField('fp-new', 'new_password', 'new-password', 'كلمة المرور الجديدة')}
      ${passwordField('fp-confirm', 'confirm', 'new-password', 'تأكيد كلمة المرور')}
      <button class="btn block" type="submit">تعيين كلمة المرور والدخول</button>
      <div class="auth-links" style="justify-content:center;margin-top:.8rem"><button type="button" class="link-btn" id="resend" disabled></button></div>`;
    bindPasswordToggles(box);
    form.elements.code.focus();
    const resend = $('#resend', box);
    let left = 60;
    const tick = () => {
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `إعادة الإرسال بعد ${left} ثانية` : 'إعادة إرسال الرمز';
      if (left-- > 0 && box.isConnected) setTimeout(tick, 1000);
    };
    tick();
    resend.addEventListener('click', async () => {
      try {
        await api('POST', '/api/password/forgot', { identifier, channel });
        toast('تم إرسال رمز جديد');
        left = 60;
        tick();
      } catch (err) {
        showError(err.message);
      }
    });
    handler = async (d) => {
      if (d.new_password !== d.confirm) throw new Error('كلمتا المرور غير متطابقتين');
      await api('POST', '/api/password/reset', { identifier, code: d.code, new_password: d.new_password });
      close();
      toast('تم تعيين كلمة المرور الجديدة');
      await enterApp();
    };
  };
  stepOne();
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
    me.is_platform ? ['platform', 'لوحة إدارة المنصة', 'layers'] : null,
    ['dashboard', 'الرئيسية', 'home'],
    ['projects', 'المشاريع', 'folder'],
    ['tasks', 'المهام', 'tasks'],
    ['reports', 'التقارير', 'report', 'reports'],
    ['requests', 'الطلبات', 'box', 'requests'],
    me.has_team ? ['team', 'متابعة الفريق', 'chart'] : null,
    ['people', me.is_admin ? 'المستخدمين' : 'الهيكل الوظيفي', 'users'],
    ['notifications', 'الإشعارات', 'bell', 'notifications'],
    me.is_admin ? ['brand', 'هوية الشركة', 'palette'] : null,
    me.is_admin ? ['subscription', 'الاشتراك', 'shield'] : null,
  ].filter(Boolean);
}

function showApp() {
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  const me = state.me;

  $('#side-nav').innerHTML = navItems().map(([key, label, ic, badge]) =>
    `<a href="#/${key}" data-nav="${key}">${icon(ic)}<span>${label}</span>${badge ? `<span class="count hidden" data-count-for="${badge}"></span>` : ''}</a>`).join('');
  drawSideUser();
  $('#side-user').onclick = accountSheet;
  $('#bell').innerHTML = `${icon('bell')}<span class="dot hidden" id="bell-dot"></span>`;
  if (!$('#topbar [data-theme-btn]')) $('#bell').insertAdjacentHTML('beforebegin', themeButton());

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
      ${sheetItem('#/people', state.me.is_admin ? 'المستخدمين' : 'الهيكل الوظيفي', 'users')}
      ${sheetItem('#/notifications', 'الإشعارات', 'bell', badge(c.notifications))}
      ${state.me.is_admin ? sheetItem('#/brand', 'هوية الشركة', 'palette') : ''}
      ${state.me.is_admin ? sheetItem('#/subscription', 'الاشتراك', 'shield') : ''}
      ${state.me.is_platform ? sheetItem('#/platform', 'لوحة إدارة المنصة', 'layers') : ''}
      <a class="item link" href="#" data-account>${icon('user')}<span class="grow">حسابي</span></a>
      <a class="item link" href="#" data-logout>${icon('logout')}<span class="grow">تسجيل الخروج</span></a>
    </div>`,
  }).el.addEventListener('click', (e) => {
    if (e.target.closest('[data-account]')) { e.preventDefault(); e.target.closest('.modal-backdrop').remove(); accountSheet(); }
    if (e.target.closest('[data-logout]')) { e.preventDefault(); e.target.closest('.modal-backdrop').remove(); logout(); }
  });
}

function drawSideUser() {
  const me = state.me;
  $('#side-user').innerHTML = `${avatar(me.name, me.id)}
    <div class="grow"><div class="name">${esc(me.name)}</div><div class="title">${esc(me.job_title || ROLE_LABELS[me.role])}</div></div>${icon('more')}`;
}

function accountSheet() {
  const me = state.me;
  const { el } = openModal({
    title: 'حسابي',
    body: `
      <div class="profile-photo">${avatar(me.name, me.id, 'xl')}
        <div class="grow"><h3 style="margin:0">${esc(me.name)}</h3>
          <div class="muted">${esc(me.job_title || ROLE_LABELS[me.role])}</div>
          <div class="row wrap" style="gap:.3rem;margin:.35rem 0 .6rem">${me.roles.map((r) => `<span class="pill blue plain">${ROLE_LABELS[r]}</span>`).join('')}</div>
          <div class="actions">
            <button class="btn sm subtle" type="button" data-photo-up>${icon('camera')}<span>${me.photo_url ? 'تغيير الصورة' : 'إضافة صورة'}</span></button>
            <button class="btn sm ghost danger-text ${me.photo_url ? '' : 'hidden'}" type="button" data-photo-del>${icon('trash')}حذف الصورة</button>
          </div></div></div>
      <div class="list" style="margin-bottom:1rem">
        <div class="item">${icon('user')}<span class="grow">البريد الإلكتروني</span><span class="muted" dir="ltr">${esc(me.email)}</span></div>
        <div class="item">${icon('users')}<span class="grow">المسؤول المباشر</span><span class="muted">${esc(me.supervisor_name || '—')}</span></div>
      </div>
      <h3>المظهر</h3>
      <div style="margin-bottom:1.2rem">${themeSwitch()}</div>
      <h3>رقم واتساب</h3>
      <div class="inline-form" style="margin-bottom:1.2rem">
        <div class="field"><input name="phone" type="tel" dir="ltr" value="${esc(me.phone ? `+${me.phone}` : '')}" placeholder="2010xxxxxxxx+"></div>
        <button class="btn subtle" type="button" data-save-phone>حفظ الرقم</button></div>
      <h3>تغيير كلمة المرور</h3>
      <div class="field"><label>كلمة المرور الحالية</label><input type="password" name="current_password" dir="ltr" autocomplete="current-password"></div>
      <div class="field"><label>كلمة المرور الجديدة</label><input type="password" name="new_password" dir="ltr" autocomplete="new-password"></div>
      <div class="row" style="gap:.5rem"><button class="btn" type="submit">حفظ كلمة المرور</button>
        <button class="btn ghost" type="button" data-logout>${icon('logout')}تسجيل الخروج</button></div>
      <div class="danger-zone">
        <div class="grow"><strong>حذف الحساب</strong><div class="muted small">إجراء نهائي لا يمكن التراجع عنه.</div></div>
        <button class="btn ghost danger-text" type="button" data-delete-account>${icon('trash')}حذف حسابي</button></div>`,
    onSubmit: async (d) => {
      await api('POST', '/api/me/password', d);
      toast('تم تغيير كلمة المرور بنجاح');
    },
    footer: false,
  });
  $('[data-logout]', el).addEventListener('click', () => { el.remove(); logout(); });
  // The new photo shows straight away wherever my avatar is: this sheet, the sidebar and the page behind.
  const photoChanged = (user) => {
    state.me.photo_url = user.photo_url;
    rememberPhotos([state.me]);
    $$(`.avatar[data-uid="${me.id}"]`).forEach((a) => {
      a.outerHTML = avatar(me.name, me.id, ['sm', 'lg', 'xl'].find((c) => a.classList.contains(c)) || '');
    });
  };
  // After the spinner has given the button its label back.
  const syncPhotoButtons = () => {
    $('[data-photo-up] span', el).textContent = state.me.photo_url ? 'تغيير الصورة' : 'إضافة صورة';
    $('[data-photo-del]', el).classList.toggle('hidden', !state.me.photo_url);
  };
  $('[data-photo-up]', el).addEventListener('click', (e) => {
    const button = e.currentTarget;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      busy(button, async () => {
        let data;
        try {
          data = await squarePhoto(file);
        } catch {
          throw new Error('تعذّرت قراءة الصورة؛ يُرجى اختيار صورة بصيغة JPG أو PNG');
        }
        photoChanged((await api('POST', '/api/me/photo', { data })).user);
        toast('تم حفظ صورتك');
      }).then(syncPhotoButtons);
    });
    input.click();
  });
  $('[data-photo-del]', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    photoChanged((await api('DELETE', '/api/me/photo')).user);
    toast('تم حذف صورتك');
  }).then(syncPhotoButtons));
  $('[data-delete-account]', el).addEventListener('click', () => { el.remove(); deleteMyAccount(); });
  $('[data-save-phone]', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const { user } = await api('PATCH', '/api/me', { phone: $('[name=phone]', el).value });
    state.me = { ...state.me, phone: user.phone };
    toast(user.phone ? 'تم حفظ رقم واتساب' : 'تم حذف الرقم');
  }));
}

// Explains exactly what happens (it depends on the person's place), then asks for the password.
function deleteMyAccount() {
  const me = state.me;
  const owner = me.role === 'owner';
  const what = owner
    ? `بصفتك صاحب الشركة، سيؤدي حذف حسابك إلى <strong>حذف شركة «${esc(me.company.name)}» بالكامل</strong> مع جميع مشاريعها ومهامها وتقاريرها. لا يمكن ذلك إلا إذا لم يبقَ في الشركة أي حساب آخر.`
    : `سيُحذف حسابك وبياناتك الشخصية نهائيًا، وتنتقل مهامك المفتوحة وفريقك وطلباتك المعلّقة إلى ${me.supervisor_name ? `<strong>${esc(me.supervisor_name)}</strong>` : 'مسؤولك المباشر'}. تبقى التقارير والسجلات السابقة محفوظة باسم «حساب محذوف».`;
  openModal({
    title: owner ? 'حذف الحساب والشركة' : 'حذف حسابي',
    danger: true,
    submitLabel: 'حذف نهائي',
    body: `<div class="callout red">${icon('alert')}<div>${what}</div></div>
      <div class="field"><label>كلمة المرور للتأكيد</label><input type="password" name="password" dir="ltr" required autocomplete="current-password"></div>
      <label class="check"><input type="checkbox" name="understood"><span class="grow">أفهم أن هذا الإجراء نهائي ولا يمكن التراجع عنه</span></label>`,
    onSubmit: async (d) => {
      if (!d.understood) throw new Error('يُرجى تأكيد أنك تفهم أن الحذف نهائي');
      const r = await api('DELETE', '/api/me', { password: d.password });
      state.me = null;
      stopPolling();
      toast(r.deleted === 'company' ? 'تم حذف الشركة وحسابك نهائيًا' : 'تم حذف حسابك نهائيًا');
      location.hash = '';
      showAuth();
    },
  });
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
  subscription: viewSubscription,
  brand: viewBrand,
  platform: (p) => (p.sub ? viewCompany(p.sub) : viewPlatform(p)),
};
// Pages that stay reachable while the company's subscription is not active.
const OPEN_WHEN_LOCKED = new Set(['subscription', 'notifications', 'platform']);

window.addEventListener('subscription-locked', (e) => {
  if (!state.me) return;
  state.me.company = { ...state.me.company, ok: false, reason: e.detail || 'expired' };
  subscriptionBanner();
  if (!location.hash.startsWith('#/subscription')) location.hash = '#/subscription';
});

export async function route() {
  if (!state.me) return;
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id, sub] = path.split('/');
  const key = routes[name] ? name : 'dashboard';
  if (state.me.company && !state.me.company.ok && !OPEN_WHEN_LOCKED.has(key)) {
    // It may have been renewed since; ask the server before locking the page.
    try { state.me = (await api('GET', '/api/me')).user; } catch { /* keep the cached state */ }
    if (!state.me.company.ok) {
      location.hash = '#/subscription';
      return;
    }
  }
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  $$('.modal-backdrop').forEach((m) => m.remove());
  setFab(null);
  const view = $('#view');
  view.innerHTML = loader();
  window.scrollTo(0, 0);
  try {
    await routes[key]({ id, sub, query: new URLSearchParams(qs) });
  } catch (err) {
    view.innerHTML = `<div class="card">${`<div class="empty">${mark()}<h3>تعذّر عرض الصفحة</h3><p>${esc(err.message)}</p>
      <a class="btn subtle" href="#/dashboard">العودة إلى الرئيسية</a></div>`}</div>`;
  }
  subscriptionBanner();
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
