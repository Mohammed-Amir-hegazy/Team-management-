// Where everything is: the menu sections (sidebar, "more" sheet), the one «إنشاء» menu for creating
// anything, and the quick search that reaches any page, project, task or person.

import { state, $, $$, esc, icon, api, openModal, avatar, statusPill, rememberPhotos, ROLE_LABELS } from './core.js';
import { taskFormModal } from './views/tasks.js';
import { newProjectModal } from './views/projects.js';
import { composeReport } from './views/reports.js';
import { newRequestModal } from './views/asks.js';

// [key, label, icon, badge, hint]
export function navSections() {
  const me = state.me;
  return [
    { items: [
      me.is_platform ? ['platform', 'لوحة إدارة المنصة', 'layers', null, 'الشركات والاشتراكات'] : null,
      ['dashboard', 'الرئيسية', 'home', null, 'المطلوب منك الآن'],
    ] },
    { title: 'عملي', items: [
      ['tasks', 'المهام', 'tasks', null, me.has_team ? 'مهامك ومهام فريقك' : 'المهام المسندة إليك'],
      ['projects', 'المشاريع', 'folder', null, 'المشاريع ومهامها ومتابعاتها الدورية'],
    ] },
    { title: 'التواصل', items: [
      ['requests', 'الطلبات', 'box', 'requests', 'اطلب من مسؤول أو زميل، والطلبات الواردة إليك'],
      ['reports', 'التقارير', 'report', 'reports', 'أرسل تقريرًا، والتقارير الواردة إليك'],
      ['notifications', 'الإشعارات', 'bell', 'notifications', 'كل ما وصلك من تنبيهات'],
    ] },
    { title: 'الفريق', items: [
      me.has_team ? ['team', 'متابعة الفريق', 'chart', null, 'أداء فريقك وتقريره الشامل'] : null,
      ['people', me.is_admin ? 'المستخدمين' : 'الهيكل الوظيفي', 'users', null, me.is_admin ? 'الحسابات والأدوار والهيكل' : 'زملاؤك ومسؤولوك'],
    ] },
    me.is_admin ? { title: 'إعدادات الشركة', items: [
      ['brand', 'هوية الشركة', 'palette', null, 'الشعار والألوان والخط في التقارير'],
      ['subscription', 'الاشتراك', 'shield', null, 'الباقة والتجديد'],
    ] } : null,
  ].filter(Boolean).map((s) => ({ ...s, items: s.items.filter(Boolean) })).filter((s) => s.items.length);
}

export function sideNavHtml() {
  return navSections().map((s) => `${s.title ? `<div class="nav-group">${s.title}</div>` : ''}${s.items.map(([key, label, ic, badge]) =>
    `<a href="#/${key}" data-nav="${key}">${icon(ic)}<span>${label}</span>${badge ? `<span class="count hidden" data-count-for="${badge}"></span>` : ''}</a>`).join('')}`).join('');
}

// ---------------------------------------------------------------------------------------------------
// «إنشاء»: everything one can create, in one place. On a page with its own way of creating the same
// thing (a task inside this project), that one is used.
// ---------------------------------------------------------------------------------------------------

export function createActions() {
  const me = state.me;
  const here = state.pageAction;
  const list = [
    ['مهمة جديدة', 'tasks', 'لك أو لأحد أعضاء فريقك، داخل مشروع أو مستقلة', () => taskFormModal({})],
    ['مشروع جديد', 'folder', 'مشروع بأعضائه، ثم أضف إليه المهام والمتابعات الدورية', newProjectModal],
    ['طلب', 'box', 'اطلب شيئًا من أحد مسؤوليك أو من زميل', () => newRequestModal()],
    (me.chain || []).length ? ['تقرير', 'send', 'أرسل تقرير حالة عملك إلى أحد مسؤوليك', () => composeReport({})] : null,
    me.is_admin ? ['مستخدم جديد', 'users', 'أضف حسابًا لأحد أفراد الشركة', () => { location.hash = '#/people?add=1'; }] : null,
  ].filter(Boolean).map(([label, ic, hint, fn]) => ({ label, ic, hint, fn: here && here.label === label ? here.fn : fn }));
  if (here && !list.some((a) => a.label === here.label)) list.unshift({ label: here.label, ic: 'plus', hint: 'في هذه الصفحة', fn: here.fn });
  return list;
}

export function createMenu() {
  const actions = createActions();
  const { el, close } = openModal({
    title: 'إنشاء',
    className: 'menu-sheet',
    body: `<div class="create-grid">${actions.map((a, i) => `<button type="button" class="create-tile" data-create="${i}">
      <span class="ic">${icon(a.ic)}</span><span class="grow"><strong>${esc(a.label)}</strong><small>${esc(a.hint)}</small></span></button>`).join('')}</div>`,
  });
  $$('[data-create]', el).forEach((b) => b.addEventListener('click', () => {
    close();
    actions[Number(b.dataset.create)].fn();
  }));
}

// ---------------------------------------------------------------------------------------------------
// Quick search (Ctrl+K or /): pages, actions, projects, tasks and people, matched loosely in Arabic.
// ---------------------------------------------------------------------------------------------------

// Spelling variants that should match each other: أ/إ/آ/ا, ة/ه, ى/ي, and no diacritics.
export const normalize = (s) => String(s || '').toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');

async function searchData() {
  const me = state.me;
  const [projects, mine, team, people] = await Promise.all([
    api('GET', '/api/projects').then((r) => r.projects).catch(() => []),
    api('GET', '/api/tasks').then((r) => r.tasks).catch(() => []),
    me.has_team ? api('GET', '/api/tasks?scope=team').then((r) => r.tasks).catch(() => []) : [],
    api('GET', '/api/colleagues').then((r) => r.colleagues).catch(() => []),
  ]);
  rememberPhotos(people);
  const seen = new Set();
  const tasks = [...mine, ...team].filter((t) => !seen.has(t.id) && seen.add(t.id));
  return { projects, tasks, people };
}

export function openSearch() {
  if ($('.search-sheet')) return;
  const pages = navSections().flatMap((s) => s.items).map(([key, label, ic, , hint]) => ({
    kind: 'page', label, sub: hint, ic, href: `#/${key}`,
  }));
  pages.push({ kind: 'page', label: 'ما الجديد في المنصة', sub: 'آخر التحديثات', ic: 'bolt', href: '#/updates' });
  const actions = createActions().map((a) => ({ kind: 'action', label: a.label, sub: a.hint, ic: 'plus', fn: a.fn }));
  let data = null;
  let results = [];
  let active = 0;

  const { el, close } = openModal({
    title: 'بحث سريع',
    className: 'search-sheet',
    body: `<div class="input-icon">${icon('search')}<input id="search-q" type="search" autocomplete="off"
        placeholder="ابحث عن مهمة أو مشروع أو شخص أو صفحة"></div>
      <div id="search-results" class="search-results" role="listbox"></div>
      <div class="muted small search-keys">↑ ↓ للتنقل · Enter للفتح · Esc للإغلاق</div>`,
  });
  const input = $('#search-q', el);
  const box = $('#search-results', el);

  const row = (r, i) => `<button type="button" class="search-row ${i === active ? 'active' : ''}" data-i="${i}" role="option">
    ${r.person ? avatar(r.person.name, r.person.id, 'sm') : `<span class="ic">${icon(r.ic)}</span>`}
    <span class="grow"><span class="label">${esc(r.label)}</span>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>
    ${r.pill || ''}</button>`;

  const draw = () => {
    const q = normalize(input.value.trim());
    const has = (...fields) => fields.some((f) => normalize(f).includes(q));
    const groups = [];
    if (!q) {
      groups.push(['إنشاء', actions], ['الصفحات', pages]);
    } else {
      groups.push(['الصفحات', pages.filter((p) => has(p.label, p.sub))]);
      groups.push(['إنشاء', actions.filter((a) => has(a.label, a.sub, 'جديد اضافه انشاء'))]);
      if (data) {
        groups.push(['المشاريع', data.projects.filter((p) => has(p.name, p.description)).slice(0, 6).map((p) => ({
          label: p.name, sub: `بإشراف ${p.creator_name}`, ic: 'folder', href: `#/projects/${p.id}`,
        }))]);
        groups.push(['المهام', data.tasks.filter((t) => has(t.title, t.project_name, t.assignee_name)).slice(0, 8).map((t) => ({
          label: t.title, sub: `${t.project_name || ''}${t.assignee_id !== state.me.id ? ` · ${t.assignee_name}` : ''}`,
          ic: 'tasks', href: `#/tasks/${t.id}`, pill: statusPill(t.status),
        }))]);
        groups.push(['الأشخاص', data.people.filter((u) => has(u.name, u.job_title)).slice(0, 6).map((u) => ({
          label: u.name, sub: u.job_title || ROLE_LABELS[u.role], person: u, fn: () => newRequestModal({ recipientId: u.id }),
          pill: '<span class="pill gray plain">إرسال طلب</span>',
        }))]);
      }
    }
    results = [];
    const html = groups.filter(([, items]) => items.length).map(([title, items]) => `<div class="search-group">${title}</div>${
      items.map((r) => { results.push(r); return row(r, results.length - 1); }).join('')}`).join('');
    if (active >= results.length) active = 0;
    box.innerHTML = html || `<div class="muted search-empty">${data ? 'لا توجد نتائج مطابقة' : '<span class="spinner"></span>'}</div>`;
    $$('.search-row', box).forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.i) === active);
      b.addEventListener('click', () => go(results[Number(b.dataset.i)]));
    });
  };
  const go = (r) => {
    if (!r) return;
    close();
    if (r.href) location.hash = r.href;
    else if (r.fn) r.fn();
  };
  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(results.length, 1);
      $$('.search-row', box).forEach((b) => b.classList.toggle('active', Number(b.dataset.i) === active));
      const cur = $('.search-row.active', box);
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  });
  draw();
  searchData().then((d) => { data = d; if (el.isConnected) draw(); });
}

// Ctrl+K / ⌘K anywhere, or "/" outside a text field.
export function bindSearchKeys() {
  document.addEventListener('keydown', (e) => {
    if (!state.me) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (((e.ctrlKey || e.metaKey) && e.code === 'KeyK') || (e.key === '/' && !typing && !$('.modal-backdrop'))) {
      e.preventDefault();
      openSearch();
    }
  });
}
