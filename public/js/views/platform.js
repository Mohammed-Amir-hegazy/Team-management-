// The platform owner's dashboard: every company, its subscription countdown, accounts and controls.

import {
  state, $, $$, esc, icon, api, render, setTitle, setFab, toast, openModal, confirmDialog, busy,
  PLAN_LABELS, PLAN_COLORS, ROLE_LABELS, countdown, periodUsed, fmtDate, fmtDateTime, relTime, kpi, avatar,
  emptyState, remember, urgency, creatorFields, bindCreatorFields, genderField,
} from '../core.js';
import { openWhatsApp, renewalReminderMessage, formalTitle } from '../whatsapp.js';
import { EVENT_LABELS, seatsMeter } from './subscription.js';

const FILTERS = [
  ['all', 'الكل'], ['trial', 'تجريبي'], ['annual', 'سنوي'], ['owned', 'ملكية دائمة'],
  ['expiring', 'ينتهي خلال 30 يومًا'], ['expired', 'منتهٍ'], ['suspended', 'موقوف'],
];
const matches = {
  all: () => true,
  trial: (c) => c.plan === 'trial',
  annual: (c) => c.plan === 'annual',
  owned: (c) => c.plan === 'owned',
  expiring: (c) => c.ok && c.days_left !== null && c.days_left <= 30,
  expired: (c) => c.reason === 'expired',
  suspended: (c) => c.reason === 'suspended',
};

function statusPill(c) {
  if (c.reason === 'suspended') return '<span class="pill red plain">موقوف</span>';
  if (c.reason === 'expired') return '<span class="pill red plain">منتهٍ</span>';
  return '<span class="pill green plain">فعّال</span>';
}

function companyCard(c, i) {
  return `<article class="card link company" data-href="#/platform/companies/${c.id}" data-name="${esc(c.name)} ${esc(c.owner ? c.owner.name : '')}" style="--i:${Math.min(i, 12)}">
    <div class="row" style="align-items:flex-start">
      <div class="grow"><h3 style="margin:0">${esc(c.name)}</h3>
        <div class="muted small">${c.owner ? esc(c.owner.name) : '—'}${c.last_activity ? ` · آخر نشاط ${esc(relTime(c.last_activity))}` : ''}</div></div>
      <div class="row" style="gap:.3rem">${`<span class="pill ${PLAN_COLORS[c.plan]} plain">${PLAN_LABELS[c.plan]}</span>`}${statusPill(c)}</div>
    </div>
    <div class="company-timer u-${c.plan === 'owned' ? 'green' : urgency(c.ends_at)}">
      ${icon('clock')}${c.plan === 'owned' ? '<span>ملكية دائمة — دون انتهاء</span>' : countdown(c.ends_at)}
    </div>
    ${c.ends_at ? `<div class="progress thin"><div data-width="${periodUsed(c.starts_at, c.ends_at)}"></div></div>` : ''}
    <div style="margin-top:.7rem">${seatsMeter(c.active_users, c.seats)}</div>
    <div class="row" style="margin-top:.8rem;gap:.4rem">
      ${c.plan !== 'owned' && c.owner && c.owner.phone ? `<button class="btn sm wa" data-wa="${c.id}">${icon('whatsapp')}تذكير المالك</button>` : ''}
      <a class="btn sm ghost" href="#/platform/companies/${c.id}" style="margin-inline-start:auto">إدارة ${icon('next')}</a>
    </div>
  </article>`;
}

export async function viewPlatform({ query }) {
  if (!state.me.is_platform) {
    render(`<div class="card">${emptyState('هذه الصفحة متاحة لإدارة منصة ابتكار فقط')}</div>`);
    return;
  }
  setTitle('لوحة إدارة المنصة');
  const { companies, totals } = await api('GET', '/api/platform/overview');
  const filter = remember('platformFilter') || 'all';
  const shown = companies.filter(matches[filter] || matches.all);

  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>لوحة إدارة المنصة</h1><div class="sub">الشركات المشتركة في منصة ابتكار واشتراكاتها وحساباتها</div></div>
      <div class="actions"><button class="btn" id="new-company">${icon('plus')}شركة جديدة</button></div>
    </div>
    ${state.config.storage_warning ? `<div class="callout red">${icon('alert')}<div><b>تحذير: البيانات ستُفقد مع التحديث القادم.</b>
      ${state.config.storage_warning === 'branch'
    ? 'المنصة متصلة بنسخة مؤقتة من قاعدة البيانات أنشأها ربط Turso مع Vercel لهذا النشر فقط، وكل نشر جديد يبدأ بنسخة فارغة.'
    : 'قاعدة البيانات مخزّنة حاليًا على قرص الخادم المؤقت، ويُمحى محتواها مع كل تحديث أو إعادة تشغيل.'}
      لحفظ البيانات بشكل دائم أضف المتغيرين <bdi dir="ltr">EBTIKAR_DB_URL</bdi> و<bdi dir="ltr">EBTIKAR_DB_TOKEN</bdi> لقاعدة بيانات ثابتة في إعدادات الخادم.</div></div>` : ''}
    <section class="kpis">
      ${kpi(totals.companies, 'إجمالي الشركات', 'layers', 'navy')}
      ${kpi(totals.annual, 'اشتراكات سنوية فعّالة', 'shield')}
      ${kpi(totals.trial, 'فترات تجريبية', 'clock', 'amber')}
      ${kpi(totals.owned, 'ملكية دائمة', 'check', 'green')}
      ${kpi(totals.expiring, 'تنتهي خلال 30 يومًا', 'alert', 'amber')}
      ${kpi(totals.expired + totals.suspended, 'منتهية أو موقوفة', 'x', 'red')}
      ${kpi(totals.users, 'حسابات نشطة', 'users')}
    </section>
    <div class="toolbar">
      <div class="input-icon">${icon('search')}<input id="q" type="search" placeholder="ابحث باسم الشركة أو مالكها"></div>
    </div>
    <div class="chips" style="margin-bottom:1rem">${FILTERS.map(([k, l]) =>
      `<button class="chip ${k === filter ? 'active' : ''}" data-filter="${k}">${l} <span class="n">${companies.filter(matches[k]).length}</span></button>`).join('')}</div>
    ${shown.length ? `<div class="grid cards stagger">${shown.map(companyCard).join('')}</div>`
      : `<div class="card">${emptyState('لا توجد شركات مطابقة')}</div>`}`);

  $$('[data-filter]', el).forEach((b) => b.addEventListener('click', () => { remember('platformFilter', b.dataset.filter); viewPlatform({ query }); }));
  $('#q', el).addEventListener('input', (e) => {
    const q = e.target.value.trim();
    $$('.company', el).forEach((card) => card.classList.toggle('hidden', q && !card.dataset.name.includes(q)));
  });
  $$('[data-wa]', el).forEach((b) => b.addEventListener('click', () => {
    const c = companies.find((x) => x.id === Number(b.dataset.wa));
    openWhatsApp(c.owner.phone, renewalReminderMessage(c));
  }));
  $('#new-company', el).addEventListener('click', newCompanyModal);
  setFab('شركة جديدة', newCompanyModal);
}

function newCompanyModal() {
  const { form } = openModal({
    title: 'شركة جديدة',
    wide: true,
    body: `
      <div class="fields">
        <div class="field"><label>اسم الشركة</label><input name="name" required></div>
        <div class="field"><label>نوع الاشتراك</label><select name="plan">
          <option value="trial">فترة تجريبية</option><option value="annual" selected>اشتراك سنوي</option><option value="owned">ملكية دائمة</option></select></div>
      </div>
      <div class="fields">
        <div class="field" data-for="annual"><label>المدة</label><select name="years">
          <option value="1">سنة واحدة</option><option value="2">سنتان</option><option value="3">ثلاث سنوات</option></select></div>
        <div class="field hidden" data-for="trial"><label>مدة التجربة (بالأيام)</label><input name="days" type="number" min="1" max="365" value="30"></div>
        <div class="field"><label>عدد الحسابات <span class="hint">(فارغ = غير محدود)</span></label><input name="seats" type="number" min="1" value="10"></div>
      </div>
      <h3>الحساب الأول في الشركة</h3>
      ${creatorFields('pc')}
      <div class="fields">
        <div class="field"><label>الاسم</label><input name="owner_name" required></div>
        <div class="field"><label>المسمى الوظيفي</label><input name="owner_job_title" placeholder="مثال: المدير العام"></div>
      </div>
      <div class="fields">
        <div class="field"><label>البريد الإلكتروني</label><input name="owner_email" type="email" dir="ltr" required></div>
        <div class="field"><label>رقم واتساب</label><input name="owner_phone" type="tel" dir="ltr" placeholder="2010xxxxxxxx+"></div>
      </div>
      <div class="fields">
        <div class="field"><label>كلمة مرور مبدئية</label><input name="owner_password" dir="ltr" required></div>
        ${genderField('', { name: 'owner_gender' })}
      </div>`,
    submitLabel: 'إنشاء الشركة',
    onSubmit: async (d) => {
      const { company } = await api('POST', '/api/platform/companies', { ...d, seats: d.seats || null });
      toast(`تم إنشاء شركة «${company.name}»`);
      location.hash = `#/platform/companies/${company.id}`;
    },
  });
  const sync = () => {
    const plan = form.elements.plan.value;
    $$('[data-for]', form).forEach((f) => f.classList.toggle('hidden', f.dataset.for !== plan));
  };
  form.elements.plan.addEventListener('change', sync);
  sync();
  bindCreatorFields(form);
}

// ---------------------------------------------------------------------------
// One company
// ---------------------------------------------------------------------------

async function subscriptionAction(companyId, body, message) {
  await api('POST', `/api/platform/companies/${companyId}/subscription`, body);
  toast(message);
  window.dispatchEvent(new Event('refresh-view'));
}

export async function viewCompany(id) {
  const { company: c, users, events, stats } = await api('GET', `/api/platform/companies/${id}`);
  setTitle(c.name);
  const el = render(`
    <div class="page-head">
      <div class="titles"><a class="crumb" href="#/platform">${icon('back')}لوحة إدارة المنصة</a>
        <h1>${esc(c.name)}</h1>
        <div class="row wrap" style="gap:.4rem;margin-top:.4rem"><span class="pill ${PLAN_COLORS[c.plan]} plain">${PLAN_LABELS[c.plan]}</span>${statusPill(c)}
          <span class="pill gray plain">منذ ${esc(fmtDate(c.created_at))}</span></div></div>
      <div class="actions">
        ${c.plan !== 'owned' ? `<button class="btn subtle" id="remind">${icon('bell')}تذكير بالتجديد</button>` : ''}
        <button class="btn ghost" id="edit">${icon('edit')}تعديل البيانات</button>
      </div>
    </div>

    <section class="sub-hero ${c.ok ? '' : 'locked'}">
      <div class="row wrap" style="gap:.5rem"><span class="pill ${PLAN_COLORS[c.plan]} plain">${PLAN_LABELS[c.plan]}</span>${statusPill(c)}</div>
      <p style="margin-top:.6rem">${c.plan === 'owned' ? 'ترخيص ملكية دائمة دون تاريخ انتهاء.' : c.ok ? 'الوقت المتبقي على انتهاء الاشتراك:' : 'انتهى الاشتراك وتوقفت الخدمة عن الشركة.'}</p>
      ${c.reason === 'suspended' ? '' : countdown(c.ends_at, { big: true })}
      ${c.ends_at ? `<div class="sub-period"><div class="progress"><div data-width="${periodUsed(c.starts_at, c.ends_at)}"></div></div>
        <div class="row small"><span>من ${esc(fmtDate(c.starts_at))}</span><span style="margin-inline-start:auto">إلى ${esc(fmtDate(c.ends_at))}</span></div></div>` : ''}
      <div class="quick">
        <button class="btn accent" data-act="renew">${icon('check')}تجديد الاشتراك</button>
        ${c.plan === 'trial' ? `<button class="btn ghost" data-act="extend">${icon('clock')}تمديد التجربة</button>` : ''}
        ${c.plan !== 'owned' ? `<button class="btn ghost" data-act="owned">${icon('shield')}تحويل إلى ملكية دائمة</button>` : ''}
        <button class="btn ghost" data-act="seats">${icon('users')}عدد الحسابات</button>
        ${c.status === 'suspended' ? `<button class="btn ghost" data-act="reactivate">${icon('check')}إعادة التفعيل</button>`
          : `<button class="btn ghost" data-act="suspend">${icon('x')}إيقاف مؤقت</button>`}
      </div>
    </section>

    <section class="kpis">
      ${kpi(c.active_users, 'حسابات نشطة', 'users')}
      ${kpi(stats.projects, 'مشاريع', 'folder')}
      ${kpi(stats.tasks, 'مهام', 'tasks')}
      ${kpi(stats.reports, 'تقارير', 'report')}
    </section>

    <div class="grid side">
      <section class="card">
        <div class="card-head"><h2>حسابات الشركة</h2><div class="actions" style="min-width:180px">${seatsMeter(c.active_users, c.seats)}</div></div>
        <div class="list">${users.map((u) => `<div class="item account ${u.active ? '' : 'off'}">
          ${avatar(u.name, u.id)}
          <div class="grow">
            <div class="row wrap" style="gap:.35rem"><strong>${esc(u.name)}</strong>
              ${u.active ? '<span class="pill green plain">نشط</span>' : '<span class="pill red plain">موقوف</span>'}</div>
            <div class="meta">${esc(u.job_title || '')}${u.job_title ? ' · ' : ''}<span dir="ltr" class="email">${esc(u.email)}</span></div>
            <div class="meta">${u.roles.map((r) => `<span class="pill gray plain">${ROLE_LABELS[r]}</span>`).join(' ')}
              <span>آخر دخول: ${u.last_login_at ? esc(relTime(u.last_login_at)) : '—'}</span></div>
          </div>
          <div class="row account-actions" style="gap:.3rem">
            ${u.phone ? `<button class="icon-btn wa" data-wa-user="${u.id}" aria-label="واتساب">${icon('whatsapp')}</button>` : ''}
            <button class="icon-btn" data-reset="${u.id}" aria-label="إعادة تعيين كلمة المرور">${icon('key')}</button>
            ${u.id !== state.me.id ? `<button class="icon-btn" data-toggle="${u.id}" aria-label="${u.active ? 'إيقاف' : 'تفعيل'}">${icon(u.active ? 'x' : 'check')}</button>` : ''}
            ${u.id !== state.me.id && u.role !== 'owner' ? `<button class="icon-btn danger-text" data-delete-user="${u.id}" aria-label="حذف الحساب">${icon('trash')}</button>` : ''}
          </div></div>`).join('')}</div>
      </section>
      <aside class="stack">
        <section class="card">
          <div class="card-head"><h3>مالك الشركة</h3></div>
          ${c.owner ? `<div class="row">${avatar(c.owner.name, c.owner.id)}<div class="grow"><strong>${esc(c.owner.name)}</strong>
            <div class="muted small" dir="ltr" style="text-align:right">${esc(c.owner.email)}</div>
            ${c.owner.phone ? `<div class="muted small" dir="ltr" style="text-align:right">+${esc(c.owner.phone)}</div>` : ''}</div></div>` : '—'}
          ${c.notes ? `<div class="callout blue" style="margin-top:.8rem">${icon('report')}<div class="pre">${esc(c.notes)}</div></div>` : ''}
        </section>
        ${users.some((u) => u.is_platform) ? '' : `<section class="danger-zone" style="margin-top:0">
          <div class="grow"><strong>حذف الشركة نهائيًا</strong>
            <div class="muted small">تُحذف الشركة وجميع حساباتها ومشاريعها ومهامها وتقاريرها، ولا يمكن التراجع.</div></div>
          <button class="btn ghost danger-text" id="delete-company">${icon('trash')}حذف الشركة</button></section>`}
        <section class="card">
          <div class="card-head"><h3>سجل الاشتراك</h3></div>
          <ul class="timeline">${events.map((e) => `<li><strong>${esc(EVENT_LABELS[e.kind] || e.kind)}</strong>
            ${e.details ? `<div class="small">${esc(e.details)}</div>` : ''}
            <div class="muted small">${e.user_name ? `${esc(e.user_name)} · ` : ''}${esc(fmtDateTime(e.created_at))}</div></li>`).join('')}</ul>
        </section>
      </aside>
    </div>`);

  const seatsField = (value) => `<div class="field"><label>عدد الحسابات <span class="hint">(فارغ = غير محدود)</span></label>
    <input name="seats" type="number" min="1" value="${value ?? ''}"></div>`;
  const actions = {
    renew: () => openModal({
      title: `تجديد اشتراك ${c.name}`,
      body: `<div class="field"><label>مدة التجديد</label><select name="years">
          <option value="1">سنة واحدة</option><option value="2">سنتان</option><option value="3">ثلاث سنوات</option></select></div>
        ${seatsField(c.seats)}
        <p class="muted small">يُضاف التجديد إلى تاريخ الانتهاء الحالي إن لم يكن قد انقضى، وإلا فيبدأ من اليوم.</p>`,
      submitLabel: 'تأكيد التجديد',
      onSubmit: (d) => subscriptionAction(c.id, { action: 'renew', years: Number(d.years), seats: d.seats || null }, 'تم تجديد الاشتراك'),
    }),
    extend: () => openModal({
      title: 'تمديد الفترة التجريبية',
      body: '<div class="field"><label>عدد الأيام</label><input name="days" type="number" min="1" max="365" value="14"></div>',
      submitLabel: 'تمديد',
      onSubmit: (d) => subscriptionAction(c.id, { action: 'extend_trial', days: Number(d.days) }, 'تم تمديد الفترة التجريبية'),
    }),
    owned: () => openModal({
      title: 'تحويل إلى ملكية دائمة',
      body: `<p>عند شراء الشركة للمنصة بالكامل يصبح الترخيص دائمًا دون تاريخ انتهاء ودون تذكيرات تجديد.</p>${seatsField(null)}`,
      submitLabel: 'تأكيد التحويل',
      onSubmit: (d) => subscriptionAction(c.id, { action: 'set_owned', seats: d.seats || null }, 'أصبحت الشركة مالكة للمنصة'),
    }),
    seats: () => openModal({
      title: 'الحد الأقصى للحسابات',
      body: seatsField(c.seats),
      onSubmit: (d) => subscriptionAction(c.id, { action: 'seats', seats: d.seats || null }, 'تم تعديل عدد الحسابات'),
    }),
    suspend: () => openModal({
      title: `إيقاف ${c.name} مؤقتًا`,
      body: '<p>سيتوقف عمل جميع حسابات الشركة مع الاحتفاظ ببياناتها كاملة.</p><div class="field"><label>السبب <span class="hint">(اختياري)</span></label><input name="note"></div>',
      submitLabel: 'إيقاف',
      danger: true,
      onSubmit: (d) => subscriptionAction(c.id, { action: 'suspend', note: d.note }, 'تم إيقاف الشركة'),
    }),
    reactivate: () => subscriptionAction(c.id, { action: 'reactivate' }, 'تمت إعادة التفعيل'),
  };
  $$('[data-act]', el).forEach((b) => b.addEventListener('click', () => actions[b.dataset.act]()));

  const remind = $('#remind', el);
  if (remind) remind.addEventListener('click', () => {
    const { el: sheet, close } = openModal({
      title: `تذكير ${c.name} بالتجديد`,
      footer: false,
      body: `<p class="muted">يصل التذكير إلى صاحب الشركة ومسؤولي النظام فيها داخل المنصة، ويمكنك إرساله أيضًا عبر واتساب برسالة رسمية.</p>
        <div class="modal-actions wrap">
          ${c.owner && c.owner.phone ? `<button type="button" class="btn wa" data-wa-owner>${icon('whatsapp')}واتساب إلى ${esc(c.owner.name)}</button>` : ''}
          <button type="button" class="btn" data-app>${icon('bell')}تذكير داخل المنصة</button></div>`,
    });
    const wa = $('[data-wa-owner]', sheet);
    if (wa) wa.addEventListener('click', () => { openWhatsApp(c.owner.phone, renewalReminderMessage(c)); close(); });
    $('[data-app]', sheet).addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const r = await api('POST', `/api/platform/companies/${c.id}/remind`, {});
      toast(`تم إرسال التذكير إلى ${r.notified} من مسؤولي الشركة`);
      close();
    }));
  });

  $('#edit', el).addEventListener('click', () => openModal({
    title: 'بيانات الشركة',
    body: `<div class="field"><label>اسم الشركة</label><input name="name" value="${esc(c.name)}" required></div>
      <div class="field"><label>ملاحظات داخلية</label><textarea name="notes" placeholder="مثال: السعر المتفق عليه وطريقة الدفع">${esc(c.notes)}</textarea></div>`,
    onSubmit: async (d) => {
      await api('PATCH', `/api/platform/companies/${c.id}`, d);
      toast('تم حفظ البيانات');
      window.dispatchEvent(new Event('refresh-view'));
    },
  }));

  const byId = new Map(users.map((u) => [u.id, u]));
  $$('[data-toggle]', el).forEach((b) => b.addEventListener('click', () => {
    const u = byId.get(Number(b.dataset.toggle));
    const run = async () => {
      await api('PATCH', `/api/platform/users/${u.id}`, { active: !u.active });
      toast(u.active ? 'تم إيقاف الحساب' : 'تم تفعيل الحساب');
      window.dispatchEvent(new Event('refresh-view'));
    };
    if (u.active) confirmDialog(`إيقاف حساب ${u.name}؟ سيُسجَّل خروجه من جميع الأجهزة.`, run, 'إيقاف');
    else run();
  }));
  $$('[data-delete-user]', el).forEach((b) => b.addEventListener('click', () => {
    const u = byId.get(Number(b.dataset.deleteUser));
    confirmDialog(`حذف حساب ${u.name} نهائيًا؟ تنتقل مهامه المفتوحة وفريقه إلى مسؤوله المباشر، وتبقى سجلاته باسم «حساب محذوف».`, async () => {
      const r = await api('DELETE', `/api/platform/users/${u.id}`, {});
      toast(r.moved_tasks ? `تم حذف الحساب ونقل ${r.moved_tasks} من مهامه` : 'تم حذف الحساب');
      window.dispatchEvent(new Event('refresh-view'));
    }, 'حذف نهائي');
  }));
  const deleteCompanyBtn = $('#delete-company', el);
  if (deleteCompanyBtn) deleteCompanyBtn.addEventListener('click', () => openModal({
    title: `حذف ${c.name} نهائيًا`,
    danger: true,
    submitLabel: 'حذف الشركة نهائيًا',
    body: `<div class="callout red">${icon('alert')}<div>ستُحذف الشركة نهائيًا مع جميع بياناتها: الحسابات (${c.total_users})، والمشاريع (${stats.projects})، والمهام (${stats.tasks})، والتقارير (${stats.reports}). لا يمكن التراجع عن هذا الإجراء.</div></div>
      <div class="field"><label>للتأكيد اكتب اسم الشركة: <strong>${esc(c.name)}</strong></label><input name="confirm_name" required autocomplete="off"></div>`,
    onSubmit: async (d) => {
      await api('DELETE', `/api/platform/companies/${c.id}`, { confirm_name: d.confirm_name });
      toast(`تم حذف شركة «${c.name}»`);
      location.hash = '#/platform';
    },
  }));
  $$('[data-reset]', el).forEach((b) => b.addEventListener('click', () => {
    const u = byId.get(Number(b.dataset.reset));
    openModal({
      title: `كلمة مرور جديدة لـ ${u.name}`,
      body: '<div class="field"><label>كلمة المرور الجديدة</label><input name="password" dir="ltr" required minlength="6"></div>',
      submitLabel: 'تعيين',
      onSubmit: async (d) => {
        await api('PATCH', `/api/platform/users/${u.id}`, { password: d.password });
        toast('تم تعيين كلمة المرور الجديدة');
      },
    });
  }));
  $$('[data-wa-user]', el).forEach((b) => b.addEventListener('click', () => {
    const u = byId.get(Number(b.dataset.waUser));
    openWhatsApp(u.phone, `${formalTitle(u)}\nتحية طيبة وبعد،\n\n…\n\nمع خالص التحية،\n${state.me.name}\nإدارة منصة ابتكار`);
  }));
  setFab(null);
}
