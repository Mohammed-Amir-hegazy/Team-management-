// The company's subscription: live countdown, plan, accounts used, history and renewal.
// Also serves as the lock screen when the subscription has ended or the company is suspended.

import {
  state, $, esc, icon, mark, api, render, setTitle, setFab, toast, openModal,
  PLAN_COLORS, countdown, periodUsed, fmtDate, fmtDateTime, emptyState,
} from '../core.js';
import { openWhatsApp, renewalRequestMessage } from '../whatsapp.js';

export const EVENT_LABELS = {
  created: 'إنشاء الاشتراك', renewed: 'تجديد', trial_extended: 'تمديد الفترة التجريبية', owned: 'تحويل إلى ملكية دائمة',
  seats: 'تعديل عدد الحسابات', suspended: 'إيقاف الحساب', reactivated: 'إعادة التفعيل', reminder: 'تذكير بالتجديد',
  renewal_request: 'طلب تجديد', edited: 'تعديل البيانات', user_activated: 'تفعيل مستخدم', user_suspended: 'إيقاف مستخدم',
  password_reset: 'إعادة تعيين كلمة مرور',
};

export function seatsMeter(used, total) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return `<div class="row"><strong>${used}</strong><span class="muted">${total ? `من ${total} حسابات` : 'حسابات (غير محدودة)'}</span>
      ${total && used >= total ? '<span class="pill red plain" style="margin-inline-start:auto">مكتمل</span>' : ''}</div>
    ${total ? `<div class="progress seats" style="margin-top:.4rem"><div data-width="${pct}" class="${pct >= 100 ? 'full' : pct >= 80 ? 'high' : ''}"></div></div>` : ''}`;
}

export async function viewSubscription() {
  setTitle('الاشتراك');
  const data = await api('GET', '/api/subscription');
  const c = data.company;
  const locked = !c.ok;
  state.me.company = { ...state.me.company, ...c };

  if (!data.can_manage) {
    render(`<section class="card lock-card">${mark()}
      <h1>${c.reason === 'suspended' ? 'حساب الشركة موقوف مؤقتًا' : locked ? 'انتهى اشتراك الشركة' : 'اشتراك الشركة فعّال'}</h1>
      <p class="muted">${locked
        ? 'لا يمكن متابعة العمل على المنصة حاليًا. يُرجى التواصل مع صاحب الشركة أو مسؤول النظام لتجديد الاشتراك، وستعود جميع بياناتكم كما هي.'
        : `شركة «${esc(c.name)}» — ${esc(c.plan_label)}${c.ends_at ? ` حتى ${esc(fmtDate(c.ends_at))}` : ''}.`}</p>
    </section>`);
    setFab(null);
    return;
  }

  const contact = data.contact || {};
  const el = render(`
    <section class="sub-hero ${locked ? 'locked' : ''}">
      ${mark('watermark')}
      <div class="row wrap" style="gap:.5rem">
        <span class="pill ${PLAN_COLORS[c.plan]} plain">${esc(c.plan_label)}</span>
        ${c.reason === 'suspended' ? '<span class="pill red plain">موقوف</span>' : locked ? '<span class="pill red plain">منتهٍ</span>' : '<span class="pill green plain">فعّال</span>'}
      </div>
      <h1>${esc(c.name)}</h1>
      <p>${c.reason === 'suspended' ? 'تم إيقاف حساب الشركة مؤقتًا من إدارة المنصة.'
        : c.plan === 'owned' ? 'تمتلك شركتكم المنصة ملكية دائمة دون الحاجة إلى تجديد.'
          : locked ? 'انتهى الاشتراك، وتوقف العمل مؤقتًا إلى حين التجديد. بياناتكم محفوظة بالكامل.'
            : `الوقت المتبقي على ${c.plan === 'trial' ? 'انتهاء الفترة التجريبية' : 'موعد التجديد'}:`}</p>
      ${c.reason === 'suspended' ? '' : countdown(c.ends_at, { big: true })}
      ${c.ends_at ? `<div class="sub-period">
        <div class="progress"><div data-width="${periodUsed(c.starts_at, c.ends_at)}"></div></div>
        <div class="row small"><span>من ${esc(fmtDate(c.starts_at))}</span><span style="margin-inline-start:auto">إلى ${esc(fmtDate(c.ends_at))}</span></div>
      </div>` : ''}
      ${c.plan !== 'owned' ? `<div class="quick">
        <button class="btn accent" id="renew">${icon('send')}طلب التجديد</button>
        ${contact.phone ? `<button class="btn ghost" id="wa-renew">${icon('whatsapp')}التواصل عبر واتساب</button>` : ''}
      </div>` : ''}
    </section>

    <div class="grid two">
      <section class="card">
        <div class="card-head"><h2>الحسابات</h2></div>
        ${seatsMeter(c.seats_used, c.seats)}
        <p class="muted small" style="margin-top:.8rem">يشغل كل حساب نشط مقعدًا واحدًا. لإضافة حسابات أكثر من الحد الحالي يُرجى طلب ترقية الباقة.</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>سجل الاشتراك</h2></div>
        ${data.events.length ? `<ul class="timeline">${data.events.map((e) => `<li>
          <strong>${esc(EVENT_LABELS[e.kind] || e.kind)}</strong>${e.details ? `<div class="small">${esc(e.details)}</div>` : ''}
          <div class="muted small">${e.user_name ? `${esc(e.user_name)} · ` : ''}${esc(fmtDateTime(e.created_at))}</div></li>`).join('')}</ul>`
          : emptyState('لا توجد أحداث بعد')}
      </section>
    </div>`);

  const renew = $('#renew', el);
  if (renew) renew.addEventListener('click', () => {
    const { el: sheet, form } = openModal({
      title: 'طلب تجديد الاشتراك',
      body: `<p class="muted">سيصل طلبك إلى إدارة منصة ابتكار، وسيتم التواصل معكم لإتمام التجديد.</p>
        <div class="field"><label>ملاحظة <span class="hint">(اختياري)</span></label>
          <textarea name="note" placeholder="مثال: نرغب في التجديد لسنة مع زيادة الحسابات إلى 20"></textarea></div>
        ${contact.phone ? `<button type="button" class="btn wa block" id="also-wa" style="margin-bottom:.6rem">${icon('whatsapp')}إرسال الطلب عبر واتساب أيضًا</button>` : ''}`,
      submitLabel: 'إرسال الطلب',
      onSubmit: async (d) => {
        await api('POST', '/api/subscription/renewal-request', d);
        toast('تم إرسال طلب التجديد إلى إدارة المنصة');
      },
    });
    const wa = $('#also-wa', sheet);
    if (wa) wa.addEventListener('click', () => openWhatsApp(contact.phone, renewalRequestMessage(c, form.elements.note.value.trim())));
  });
  const waRenew = $('#wa-renew', el);
  if (waRenew) waRenew.addEventListener('click', () => openWhatsApp(contact.phone, renewalRequestMessage(c)));
  setFab(null);
}

// Thin bar above every page for owners/admins during a trial or the last 30 days, and for anyone once locked.
export function subscriptionBanner() {
  const box = $('#sub-banner');
  if (!box) return;
  const me = state.me;
  const c = me && me.company;
  const onPage = location.hash.startsWith('#/subscription');
  if (!c || onPage || c.plan === 'owned' || (!me.is_admin && c.ok) || (c.ok && c.plan !== 'trial' && c.days_left > 30)) {
    box.innerHTML = '';
    return;
  }
  const label = !c.ok ? (c.reason === 'suspended' ? 'حساب الشركة موقوف' : 'انتهى الاشتراك')
    : c.plan === 'trial' ? 'الفترة التجريبية — متبقٍ' : 'موعد تجديد الاشتراك — متبقٍ';
  box.innerHTML = `<a class="sub-banner u-${!c.ok ? 'red' : c.days_left <= 7 ? 'red' : 'amber'}" href="#/subscription">
    ${icon('clock')}<span>${label}</span>${c.ok ? countdown(c.ends_at) : ''}
    <span class="go">${me.is_admin ? 'عرض الاشتراك والتجديد' : 'التفاصيل'} ${icon('next')}</span></a>`;
}
