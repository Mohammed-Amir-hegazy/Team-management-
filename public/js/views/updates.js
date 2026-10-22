// "What's new": every platform update, with the steps owners and system admins need to take. The latest
// one also opens by itself once, the first time each person signs in after it.

import { state, esc, icon, api, render, setTitle, setFab, openModal, fmtDate, emptyState } from '../core.js';

function releaseHtml(r) {
  return `<div class="release">
    <div class="muted small">${esc(fmtDate(r.date))}</div>
    <h3>${esc(r.title)}</h3>
    <ul class="release-list">${r.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    ${r.actions.length ? `<div class="callout amber">${icon('alert')}<div class="grow"><strong>خطوات مطلوبة منكم</strong>
      ${r.actions.map((a) => `<div class="release-action"><span class="grow">${esc(a.text)}</span>
        <a class="btn sm" href="${esc(a.link)}" data-close>تنفيذ الآن</a></div>`).join('')}</div></div>` : ''}
  </div>`;
}

export async function viewUpdates() {
  setTitle('ما الجديد');
  setFab(null);
  const { releases } = await api('GET', '/api/releases');
  render(`
    <div class="page-head"><div class="titles"><h1>ما الجديد في المنصة</h1>
      <div class="sub">تفاصيل كل تحديث، والخطوات المطلوبة من صاحب الشركة ومسؤول النظام</div></div></div>
    <section class="card stack">${releases.length ? releases.map(releaseHtml).join('<hr>') : emptyState('لا توجد تحديثات بعد')}</section>`);
}

// Once per person and update (remembered on this device).
export async function showWhatsNew() {
  if (location.hash.startsWith('#/updates')) return;
  let releases;
  try {
    ({ releases } = await api('GET', '/api/releases'));
  } catch {
    return;
  }
  const latest = releases[0];
  if (!latest) return;
  const key = `seenRelease:${state.me.id}`;
  try {
    if (localStorage.getItem(key) === latest.id) return;
    localStorage.setItem(key, latest.id);
  } catch {
    return;
  }
  const { el, close } = openModal({
    title: 'تحديث جديد على المنصة',
    wide: true,
    footer: false,
    body: `${releaseHtml(latest)}
      <div class="modal-actions"><button type="button" class="btn" data-ok>تم</button>
        <a class="btn ghost" href="#/updates" data-close>كل التحديثات</a></div>`,
  });
  el.querySelector('[data-ok]').addEventListener('click', close);
  el.querySelectorAll('[data-close]').forEach((a) => a.addEventListener('click', close));
}
