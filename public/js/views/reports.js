import {
  state, $, $$, esc, icon, mark, api, render, setTitle, setFab, toast, openModal,
  STATUS_LABELS, STATUSES, PRIORITY_LABELS, ROLE_LABELS, statusPill, avatar, tabs, onTabs, remember, relTime,
  fmtDateTime, fmtDate, deadlineInfo, emptyState, stackBar, plural, TASKS_N, managerPicker, colleagueTitle, honorific,
} from '../core.js';
import { uploadImages, pickImages, gallery, bindGallery, thumb, progressBar } from '../uploads.js';
import { openWhatsApp, reportMessage } from '../whatsapp.js';
import { currentBrand, brandStyle, brandLogo, brandIssuer, loadBrandFont } from '../brand.js';

export function summaryPills(s) {
  if (!s) return '';
  return `${s.total ? `<span class="pill gray plain">${plural(s.total, TASKS_N)}</span>` : '<span class="pill gray plain">لا توجد مهام</span>'}
    ${STATUSES.map((k) => (s[k] ? `<span class="pill st-${k}">${STATUS_LABELS[k]} ${s[k]}</span>` : '')).join('')}
    ${s.overdue ? `<span class="pill amber plain">${icon('clock')} ${s.overdue} متأخرة</span>` : ''}`;
}

// ---------------------------------------------------------------------------
// The report as a branded Ebtikar document (used on screen and for PDF)
// ---------------------------------------------------------------------------

function kpiTiles(s) {
  return `<div class="rd-kpis">
    <div class="t"><div class="n">${s.total}</div><div class="l">إجمالي المهام</div></div>
    <div class="t blue"><div class="n">${s.in_progress}</div><div class="l">قيد التنفيذ</div></div>
    <div class="t amber"><div class="n">${s.review}</div><div class="l">قيد المراجعة</div></div>
    <div class="t red"><div class="n">${s.blocked}</div><div class="l">متوقفة</div></div>
    <div class="t red"><div class="n">${s.overdue}</div><div class="l">متأخرة عن موعدها</div></div>
    <div class="t green"><div class="n">${s.done}</div><div class="l">مكتملة</div></div>
  </div>`;
}

function tasksTable(tasks) {
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>المهمة</th><th>المشروع</th><th>الحالة</th><th>الملاحظة / السبب</th><th>الأولوية</th><th>الموعد النهائي</th></tr></thead>
    <tbody>${tasks.map((t) => {
      const dl = deadlineInfo(t.deadline, t.status);
      return `<tr><td><a href="#/tasks/${t.id}"><strong>${esc(t.title)}</strong></a>
          ${t.images && t.images.length ? `<div class="rd-task-images">${t.images.map((img) =>
            `<img src="${esc(thumb(img.url, 96))}" alt="${esc(img.caption || '')}" data-full="${esc(img.url)}" data-caption="${esc(img.caption || '')}">`).join('')}</div>` : ''}</td>
        <td>${esc(t.project_name)}</td><td>${statusPill(t.status)}</td><td>${esc(t.status_note || '—')}</td>
        <td>${PRIORITY_LABELS[t.priority] || ''}</td>
        <td class="${dl.late ? 'late' : ''} nowrap">${t.deadline ? esc(fmtDate(t.deadline)) : '—'}${dl.late ? '<br><small>متأخرة</small>' : ''}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function teamTable(team) {
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>العضو</th><th>التوزيع</th><th class="num">قيد التنفيذ</th><th class="num">متوقفة</th><th class="num">متأخرة</th><th class="num">مكتملة</th></tr></thead>
    <tbody>${team.map((m) => `<tr><td><div class="row">${avatar(m.name, m.id, 'sm')}<div><div>${esc(m.name)}</div>
      <div class="muted small">${esc(m.job_title || '')}</div></div></div></td>
      <td style="min-width:110px">${stackBar(m)}</td><td class="num">${m.in_progress}</td>
      <td class="num ${m.blocked ? 'late' : ''}">${m.blocked}</td><td class="num ${m.overdue ? 'late' : ''}">${m.overdue}</td>
      <td class="num">${m.done}</td></tr>`).join('')}</tbody></table></div>`;
}

export function reportDocHtml(r, f = null, brand = currentBrand()) {
  const base = f || r;
  const snap = base.snapshot;
  const images = [...(r.images || []), ...((f && f.images) || [])];
  const scope = base.task_id ? `المهمة: ${base.task_title}` : base.project_id ? base.project_name : 'جميع الأعمال';
  return `<article class="report-doc ${brand.custom ? 'branded' : ''}" style="${brandStyle(brand)}">
    <header class="rd-head">${brand.logo_url ? '' : mark('watermark')}
      <div class="rd-brand">${brandLogo(brand)}</div>
      <span class="rd-kind">${f ? 'تقرير مُحال' : 'تقرير حالة العمل'}</span>
      <h1>${esc(r.title)}</h1>
      <div class="sub">رقم التقرير ${r.id} · ${esc(fmtDateTime(r.created_at))}</div>
    </header>
    <div class="rd-meta">
      <div><div class="k">مقدَّم من</div><div class="v">${avatar(r.sender_name, r.sender_id, 'sm')}${esc(colleagueTitle({ id: r.sender_id, name: r.sender_name }))}</div>
        <div class="muted small">${esc(r.sender_job_title || '')}</div></div>
      <div><div class="k">مرفوع إلى</div><div class="v">${avatar(r.recipient_name, r.recipient_id, 'sm')}${esc(honorific({ id: r.recipient_id, name: r.recipient_name }))}</div></div>
      <div><div class="k">النطاق</div><div class="v">${esc(scope)}</div></div>
      <div><div class="k">حالة التقرير</div><div class="v">${r.reply ? 'تم الرد عليه' : r.read_at ? 'تم الاطلاع عليه' : 'لم يُطّلع عليه بعد'}</div></div>
    </div>
    ${snap ? `<section class="rd-section"><h2>ملخص حالة العمل</h2>${kpiTiles(snap.summary)}
      <div class="muted small" style="margin-top:.6rem">الحالة كما كانت في ${esc(fmtDateTime(snap.generated_at))}</div></section>` : ''}
    ${f ? `<section class="rd-section"><h2>تعليق ${esc(r.sender_name)}</h2><div class="rd-body pre">${esc(r.body)}</div></section>
      <section class="rd-section"><h2>نص التقرير الأصلي من ${esc(f.sender_name)}</h2>
        <div class="muted small" style="margin-bottom:.4rem">${esc(f.title)} · ${esc(fmtDateTime(f.created_at))}</div>
        <div class="rd-body pre">${esc(f.body)}</div></section>`
      : `<section class="rd-section"><h2>نص التقرير</h2><div class="rd-body pre">${esc(r.body)}</div></section>`}
    ${images.length ? `<section class="rd-section"><h2>صور مرفقة</h2>${gallery(images)}</section>` : ''}
    ${snap && snap.tasks.length ? `<section class="rd-section"><h2>تفاصيل المهام</h2>${tasksTable(snap.tasks)}</section>` : ''}
    ${snap && snap.team && snap.team.length ? `<section class="rd-section"><h2>ملخص الفريق</h2>${teamTable(snap.team)}</section>` : ''}
    ${r.reply ? `<section class="rd-section"><h2>ردّ ${esc(r.recipient_name)}</h2><div class="callout green">${icon('reply')}<div>
      <div class="pre">${esc(r.reply)}</div><div class="small">${esc(fmtDateTime(r.replied_at))}</div></div></div></section>` : ''}
    <footer class="rd-foot"><span>${esc(brandIssuer(brand))}</span><span dir="ltr">Ebtikar Software Solutions</span></footer>
  </article>`;
}

async function printReport(r, f) {
  const root = $('#print-root');
  await loadBrandFont(currentBrand());
  root.innerHTML = reportDocHtml(r, f);
  await Promise.all($$('img', root).map((img) => img.decode().catch(() => {})));
  await document.fonts.ready;
  const title = document.title;
  document.title = `Ebtikar-Report-${r.id}`;
  window.print();
  document.title = title;
}

// ---------------------------------------------------------------------------
// WhatsApp: to my direct supervisor or anyone above
// ---------------------------------------------------------------------------

export function shareReportOnWhatsApp(report) {
  const chain = state.me.chain || [];
  if (!chain.length) {
    toast('لا يوجد مسؤولون أعلى منك لإرسال التقرير إليهم', { error: true });
    return;
  }
  const { el, close } = openModal({
    title: 'إرسال التقرير عبر واتساب',
    footer: false,
    body: `<p class="muted">اختر المستلم؛ تُجهَّز الرسالة بصيغة رسمية تتضمن ملخص حالة العمل والمهام والصور ورابط التقرير.</p>
      <div class="list">${chain.map((p, i) => `<div class="item">${avatar(p.name, p.id)}
        <div class="grow"><div class="title">${esc(p.name)}</div>
          <div class="meta">${esc(p.job_title || ROLE_LABELS[p.role])} · ${i === 0 ? 'مسؤولك المباشر' : 'مستوى أعلى'}</div></div>
        ${p.phone ? `<button type="button" class="btn sm wa" data-wa="${i}">${icon('whatsapp')}واتساب</button>`
          : '<span class="muted small">لا يوجد رقم</span>'}</div>`).join('')}</div>`,
  });
  $$('[data-wa]', el).forEach((b) => b.addEventListener('click', () => {
    const p = chain[Number(b.dataset.wa)];
    openWhatsApp(p.phone, reportMessage(report, p, 'up'));
    close();
  }));
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

export async function composeReport({ project_id: projectId = null, task_id: taskId = null, label = '' } = {}) {
  const me = state.me;
  if (!me.supervisor_id) {
    toast('لا يوجد مسؤول مباشر أعلى منك لإرسال التقرير إليه', { error: true });
    return;
  }
  const projects = !projectId && !taskId ? (await api('GET', '/api/projects')).projects : [];
  const images = [];
  const { form } = openModal({
    title: 'تقرير جديد',
    wide: true,
    body: `
      ${managerPicker('يُرسل التقرير إلى')}
      ${label ? `<div class="muted small" style="margin:-.4rem 0 .8rem">بخصوص ${esc(label)}</div>` : ''}
      ${projects.length ? `<div class="field"><label>نطاق التقرير</label><select name="scope">
        <option value="">جميع أعمالي</option>
        ${projects.map((p) => `<option value="${p.id}">مشروع: ${esc(p.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>عنوان التقرير</label><input name="title" required value="تقرير حالة العمل — ${esc(fmtDate(new Date().toISOString()))}"></div>
      <div class="field"><label>نص التقرير</label><textarea name="body" rows="6" required
        placeholder="ما الذي أُنجز؟ وما العوائق الحالية؟ وما الخطوات القادمة؟"></textarea></div>
      ${state.config.uploads ? `<div class="field"><div class="row"><label>صور مرفقة</label>
        <button type="button" class="btn sm subtle" id="add-report-photos" style="margin-inline-start:auto">${icon('camera')}إرفاق صور</button></div>
        <div id="report-photos"></div><div id="report-progress"></div></div>` : ''}
      <label class="switch" style="margin-bottom:.7rem"><input type="checkbox" name="include_status" checked>
        إرفاق حالة العمل تلقائيًا (المهام وحالاتها وأسباب التوقف وصورها${me.has_team ? ' وملخص الفريق' : ''})</label>
      <div id="snap-preview" class="snapshot"><div class="skeleton" style="height:22px;width:60%"></div></div>`,
    submitLabel: 'إرسال التقرير',
    onSubmit: async (d) => {
      const scope = d.scope ? Number(d.scope) : projectId;
      const { report } = await api('POST', '/api/reports', {
        title: d.title, body: d.body, project_id: scope, task_id: taskId, include_status: d.include_status, images,
        recipient_id: Number(d.recipient_id) || null,
      });
      location.hash = `#/reports/${report.id}?sent=1`;
    },
  });

  const photosBox = $('#report-photos', form);
  const drawPhotos = () => {
    photosBox.innerHTML = images.length ? `<div class="gallery">${images.map((img, i) => `<figure class="shot">
      <div class="shot-open" style="cursor:default"><img src="${esc(thumb(img.url))}" alt=""></div>
      <button type="button" class="shot-del" data-remove="${i}" aria-label="إزالة">${icon('x')}</button></figure>`).join('')}</div>` : '';
    $$('[data-remove]', photosBox).forEach((b) => b.addEventListener('click', () => { images.splice(Number(b.dataset.remove), 1); drawPhotos(); }));
  };
  const addPhotos = $('#add-report-photos', form);
  if (addPhotos) addPhotos.addEventListener('click', async () => {
    const files = await pickImages();
    if (!files.length) return;
    addPhotos.disabled = true;
    try {
      images.push(...await uploadImages(files, { purpose: 'report' }, progressBar($('#report-progress', form))));
      drawPhotos();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      addPhotos.disabled = false;
      $('#report-progress', form).innerHTML = '';
    }
  });

  const preview = $('#snap-preview', form);
  const load = async () => {
    const scope = form.elements.scope ? form.elements.scope.value : projectId;
    const qs = new URLSearchParams();
    if (taskId) qs.set('task_id', taskId);
    else if (scope) qs.set('project_id', scope);
    try {
      const { snapshot: s } = await api('GET', `/api/reports/preview?${qs}`);
      const photoCount = s.tasks.reduce((n, t) => n + (t.images ? t.images.length : 0), 0);
      preview.innerHTML = `<div class="muted small" style="margin-bottom:.3rem">سيُرفق مع التقرير:</div>
        <div class="sum" style="margin:0">${summaryPills(s.summary)}
        ${photoCount ? `<span class="pill blue plain">${icon('camera')} ${photoCount} صورة من المهام</span>` : ''}
        ${s.team.length ? `<span class="pill navy plain">${icon('users')} ملخص ${s.team.length} من أعضاء الفريق</span>` : ''}</div>`;
    } catch (err) {
      preview.innerHTML = `<span class="muted small">${esc(err.message)}</span>`;
    }
  };
  load();
  if (form.elements.scope) form.elements.scope.addEventListener('change', load);
  form.elements.include_status.addEventListener('change', (e) => preview.classList.toggle('hidden', !e.target.checked));
}

// ---------------------------------------------------------------------------
// List & detail
// ---------------------------------------------------------------------------

export async function viewReports({ query }) {
  setTitle('التقارير');
  const me = state.me;
  const boxes = [['inbox', 'الوارد'], ['sent', 'المرسل']];
  if (me.has_team) boxes.push(['team', 'تقارير الفريق']);
  let box = query.get('box') || remember('reportBox') || 'inbox';
  if (!boxes.some(([k]) => k === box)) box = 'inbox';
  remember('reportBox', box);
  const { reports } = await api('GET', `/api/reports?box=${box}`);

  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>التقارير</h1><div class="sub">تُرسل التقارير إلى المسؤول المباشر وتتضمن حالة العمل كاملة</div></div>
      <div class="actions">
        ${me.supervisor_id ? `<button class="btn" id="new-report">${icon('send')}تقرير جديد</button>` : ''}
        ${me.has_team ? `<a class="btn ghost" href="#/team">${icon('download')}تقرير الفريق الشامل</a>` : ''}
      </div>
    </div>
    ${tabs(boxes, box)}
    <section class="card">
      ${reports.length ? `<div class="list stagger">${reports.map((r, i) => {
        const person = box === 'sent' ? { name: r.recipient_name, id: r.recipient_id } : { name: r.sender_name, id: r.sender_id };
        const unread = box === 'inbox' && !r.read_at;
        const s = r.status_summary;
        return `<div class="item link ${unread ? 'unread' : ''}" data-href="#/reports/${r.id}" style="--i:${Math.min(i, 12)}">
          ${avatar(person.name, person.id)}
          <div class="grow">
            <div class="title">${esc(r.title)}</div>
            <div class="meta">${box === 'sent' ? `إلى ${esc(r.recipient_name)}` : box === 'team' ? `${esc(r.sender_name)} ← ${esc(r.recipient_name)}` : `من ${esc(r.sender_name)}`}
              · ${esc(relTime(r.created_at))}
              ${r.project_name ? `· ${icon('folder')} ${esc(r.project_name)}` : ''}
              ${s && s.blocked ? `<span class="pill red plain">${s.blocked} متوقفة</span>` : ''}
              ${s && s.overdue ? `<span class="pill amber plain">${s.overdue} متأخرة</span>` : ''}</div>
          </div>
          ${r.reply ? '<span class="pill green">تم الرد</span>' : ''}
        </div>`;
      }).join('')}</div>` : emptyState(
        box === 'inbox' ? 'لا توجد تقارير واردة' : box === 'sent' ? 'لم ترسل أي تقرير بعد' : 'لا توجد تقارير من فريقك',
        box === 'sent' && me.supervisor_id ? 'أرسل تقريرك الأول وستُرفق حالة عملك تلقائيًا.' : '')}
    </section>`);

  onTabs(el, (tab) => { location.hash = `#/reports?box=${tab}`; });
  const btn = $('#new-report', el);
  if (btn) {
    btn.addEventListener('click', () => composeReport({}));
    setFab('تقرير جديد', () => composeReport({}));
  }
}

export async function viewReport({ id, query }) {
  const { report: r, forwarded_from: f, permissions: can } = await api('GET', `/api/reports/${id}`);
  setTitle('تقرير');
  const el = render(`
    <div class="page-head">
      <div class="titles"><a class="crumb" href="#/reports">${icon('back')}التقارير</a></div>
      <div class="actions">
        ${can.reply ? `<button class="btn" id="reply">${icon('reply')}رد</button>` : ''}
        ${can.forward ? `<button class="btn ghost" id="forward">${icon('forward')}إحالة إلى مستوى أعلى</button>` : ''}
        ${(state.me.chain || []).length ? `<button class="btn wa" id="wa">${icon('whatsapp')}إرسال عبر واتساب</button>` : ''}
        <button class="btn ghost" id="pdf">${icon('pdf')}تنزيل PDF</button>
      </div>
    </div>
    ${reportDocHtml(r, f)}`);
  bindGallery(el);
  loadBrandFont(currentBrand());

  $('#pdf', el).addEventListener('click', () => printReport(r, f));
  const wa = $('#wa', el);
  if (wa) wa.addEventListener('click', () => shareReportOnWhatsApp(f ? { ...r, snapshot: f.snapshot, images: [...r.images, ...f.images] } : r));
  if (can.reply) $('#reply', el).addEventListener('click', () => openModal({
    title: 'الرد على التقرير',
    body: '<div class="field"><label>نص الرد</label><textarea name="reply" required></textarea></div>',
    submitLabel: 'إرسال الرد',
    onSubmit: async (d) => {
      await api('POST', `/api/reports/${r.id}/reply`, d);
      toast('تم إرسال الرد');
      viewReport({ id, query: new URLSearchParams() });
    },
  }));
  if (can.forward) $('#forward', el).addEventListener('click', () => openModal({
    title: 'إحالة التقرير',
    body: `${managerPicker('إحالة إلى')}
      <div class="field"><label>تعليقك <span class="hint">(اختياري)</span></label><textarea name="note"></textarea></div>`,
    submitLabel: 'إحالة',
    onSubmit: async (d) => {
      const res = await api('POST', `/api/reports/${r.id}/forward`, { note: d.note, recipient_id: Number(d.recipient_id) || null });
      toast('تمت إحالة التقرير');
      location.hash = `#/reports/${res.report_id}`;
    },
  }));
  setFab(null);

  // Right after sending: confirm, and offer the same report on WhatsApp in one tap.
  if (query && query.get('sent') && r.sender_id === state.me.id) {
    history.replaceState(null, '', `#/reports/${r.id}`);
    const boss = (state.me.chain || [])[0];
    const { el: sheet, close } = openModal({
      title: 'تم إرسال التقرير',
      footer: false,
      body: `<div class="callout green">${icon('check')}<div>وصل التقرير إلى <strong>${esc(r.recipient_name)}</strong> على المنصة، مع حالة العمل كاملة.</div></div>
        <div class="modal-actions wrap">
          ${boss && boss.phone ? `<button type="button" class="btn wa" data-direct>${icon('whatsapp')}إرساله أيضًا عبر واتساب إلى ${esc(boss.name)}</button>` : ''}
          ${(state.me.chain || []).length > 1 ? '<button type="button" class="btn ghost" data-choose>اختيار مستلم آخر</button>' : ''}
          <button type="button" class="btn ghost" data-close>تم</button>
        </div>`,
    });
    const direct = $('[data-direct]', sheet);
    if (direct) direct.addEventListener('click', () => { openWhatsApp(boss.phone, reportMessage(r, boss, 'up')); close(); });
    const choose = $('[data-choose]', sheet);
    if (choose) choose.addEventListener('click', () => { close(); shareReportOnWhatsApp(r); });
  }
}
