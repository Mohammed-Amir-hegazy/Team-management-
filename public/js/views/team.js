import {
  state, $, $$, esc, icon, mark, api, render, setTitle, setFab, toast, busy,
  STATUS_LABELS, PRIORITY_LABELS, ROLE_LABELS, statusPill, avatar, kpi, stackBar, emptyState,
  fmtDate, fmtDateTime, relTime, taskList,
} from '../core.js';
import { summaryPills } from './reports.js';
import { buildXlsx, download } from '../xlsx.js';

const DAY = 24 * 3600 * 1000;

function periodFrom(query) {
  const p = query.get('p') || '7';
  if (p === 'custom' && query.get('from') && query.get('to')) {
    const from = new Date(`${query.get('from')}T00:00:00`);
    const to = new Date(`${query.get('to')}T23:59:59`);
    return { p, from, to };
  }
  const to = new Date();
  if (p === 'month') return { p, from: new Date(to.getFullYear(), to.getMonth(), 1), to };
  return { p: p === '30' ? '30' : '7', from: new Date(to.getTime() - (p === '30' ? 30 : 7) * DAY), to };
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function viewTeam({ query }) {
  setTitle('متابعة الفريق');
  if (!state.me.has_team) {
    render(`<div class="card">${emptyState('هذه الصفحة متاحة لمن لديهم فريق عمل')}</div>`);
    return;
  }
  const period = periodFrom(query);
  const data = await api('GET', `/api/team-report?from=${period.from.toISOString()}&to=${period.to.toISOString()}`);
  const { totals, members, tasks, reports } = data;
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const overdue = tasks.filter((t) => t.overdue && t.status !== 'blocked');

  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>متابعة الفريق</h1>
        <div class="sub">الفترة من ${esc(fmtDate(data.period.from))} إلى ${esc(fmtDate(data.period.to))}</div></div>
      <div class="actions">
        <button class="btn" id="pdf">${icon('pdf')}تنزيل التقرير PDF</button>
        <button class="btn accent" id="xlsx">${icon('sheet')}تنزيل Excel</button>
      </div>
    </div>

    <div class="row wrap" style="margin-bottom:1rem;gap:.6rem">
      <div class="chips">
        ${[['7', 'آخر 7 أيام'], ['30', 'آخر 30 يومًا'], ['month', 'الشهر الحالي'], ['custom', 'فترة مخصصة']].map(([k, l]) =>
          `<button class="chip ${period.p === k ? 'active' : ''}" data-p="${k}">${l}</button>`).join('')}
      </div>
      <form id="custom" class="inline-form ${period.p === 'custom' ? '' : 'hidden'}" style="flex:1">
        <div class="field"><label>من</label><input type="date" name="from" value="${isoDay(period.from)}"></div>
        <div class="field"><label>إلى</label><input type="date" name="to" value="${isoDay(period.to)}"></div>
        <button class="btn subtle" type="submit">عرض</button>
      </form>
    </div>

    <section class="kpis">
      ${kpi(totals.members, 'أعضاء الفريق', 'users', 'navy')}
      ${kpi(totals.total, 'مهام مفتوحة', 'tasks')}
      ${kpi(totals.blocked, 'متوقفة', 'alert', 'red')}
      ${kpi(totals.overdue, 'متأخرة عن موعدها', 'clock', 'amber')}
      ${kpi(totals.done_in_period, 'أُنجزت خلال الفترة', 'check', 'green')}
      ${kpi(totals.reports, 'تقارير مرفوعة', 'report')}
    </section>

    <section class="card">
      <div class="card-head"><h2>أعضاء الفريق</h2><span class="muted small">اضغط على العضو لعرض مهامه</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>العضو</th><th>توزيع المهام</th><th class="num">قيد التنفيذ</th><th class="num">متوقفة</th>
          <th class="num">قيد المراجعة</th><th class="num">متأخرة</th><th class="num">أُنجزت في الفترة</th></tr></thead>
        <tbody class="stagger">${members.map((m, i) => `<tr class="link" data-href="#/tasks?scope=team&assignee=${m.id}" style="--i:${Math.min(i, 12)}">
          <td><div class="row">${avatar(m.name, m.id, 'sm')}<div><div><strong>${esc(m.name)}</strong></div>
            <div class="muted small">${esc(m.job_title || ROLE_LABELS[m.role])}${m.supervisor_name ? ` · يتبع ${esc(m.supervisor_name)}` : ''}</div></div></div></td>
          <td style="min-width:130px">${stackBar(m.stats)}</td>
          <td class="num">${m.stats.in_progress}</td>
          <td class="num ${m.stats.blocked ? 'late' : ''}">${m.stats.blocked}</td>
          <td class="num">${m.stats.review}</td>
          <td class="num ${m.stats.overdue ? 'late' : ''}">${m.stats.overdue}</td>
          <td class="num">${m.stats.done_in_period}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>

    <div class="grid two" style="margin-top:1rem">
      <section class="card"><div class="card-head"><h2>المهام المتوقفة وأسبابها</h2></div>
        ${taskList(blocked, { showAssignee: true, emptyTitle: 'لا توجد مهام متوقفة' })}</section>
      <section class="card"><div class="card-head"><h2>المهام المتأخرة</h2></div>
        ${taskList(overdue, { showAssignee: true, emptyTitle: 'لا توجد مهام متأخرة' })}</section>
    </div>

    <section class="card" style="margin-top:1rem">
      <div class="card-head"><h2>تقارير الفريق خلال الفترة</h2>
        <div class="actions"><a class="btn sm ghost" href="#/reports?box=team">جميع تقارير الفريق</a></div></div>
      ${reports.length ? `<div class="list">${reports.map((r) => `<div class="item link" data-href="#/reports/${r.id}">
        ${avatar(r.sender_name, r.sender_id)}<div class="grow"><div class="title">${esc(r.title)}</div>
        <div class="meta">${esc(r.sender_name)} ← ${esc(r.recipient_name)} · ${esc(relTime(r.created_at))}
          ${r.status_summary && r.status_summary.blocked ? `<span class="pill red plain">${r.status_summary.blocked} متوقفة</span>` : ''}</div></div></div>`).join('')}</div>`
        : emptyState('لا توجد تقارير خلال هذه الفترة')}
    </section>`);

  const go = (p, extra = {}) => {
    const qs = new URLSearchParams({ p, ...extra });
    location.hash = `#/team?${qs}`;
  };
  $$('[data-p]', el).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.p === 'custom') {
      $('#custom', el).classList.remove('hidden');
      $$('[data-p]', el).forEach((x) => x.classList.toggle('active', x === b));
    } else {
      go(b.dataset.p);
    }
  }));
  $('#custom', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const { from, to } = e.target.elements;
    if (!from.value || !to.value || from.value > to.value) { toast('يُرجى تحديد فترة صحيحة', { error: true }); return; }
    go('custom', { from: from.value, to: to.value });
  });
  $('#pdf', el).addEventListener('click', (e) => busy(e.currentTarget, () => printReport(data)));
  $('#xlsx', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    download(teamWorkbook(data), `Ebtikar-Team-Report-${isoDay(new Date())}.xlsx`);
    toast('تم تجهيز ملف Excel');
  }));
  setFab(null);
}

// ---------------------------------------------------------------------------
// PDF (print-ready document; the browser saves it as PDF)
// ---------------------------------------------------------------------------

async function printReport(data) {
  const { totals, members, tasks, reports, requests } = data;
  const byMember = new Map(members.map((m) => [m.id, []]));
  for (const t of tasks) if (byMember.has(t.assignee_id)) byMember.get(t.assignee_id).push(t);
  const root = $('#print-root');
  root.innerHTML = `<div class="doc">
    <div class="doc-head">
      <div><h1>تقرير أداء الفريق</h1>
        <div>الفترة من ${esc(fmtDate(data.period.from))} إلى ${esc(fmtDate(data.period.to))}</div></div>
      <div>
        <div class="brand">${mark()}<img src="/brand/wordmark-navy.svg" alt="EBTIKAR"></div>
        <div class="meta">أعدّه: ${esc(data.generated_by.name)}${data.generated_by.job_title ? ` — ${esc(data.generated_by.job_title)}` : ''}<br>
          تاريخ الإصدار: ${esc(fmtDateTime(data.generated_at))}</div>
      </div>
    </div>

    <div class="kpis">
      ${[[totals.members, 'أعضاء الفريق'], [totals.total, 'مهام مفتوحة'], [totals.blocked, 'متوقفة'],
        [totals.overdue, 'متأخرة'], [totals.done_in_period, 'أُنجزت في الفترة'], [totals.reports, 'تقارير مرفوعة']]
        .map(([n, l]) => `<div class="kpi"><span class="num">${n}</span><span class="label">${l}</span></div>`).join('')}
    </div>

    <h2>ملخص أعضاء الفريق</h2>
    <table><thead><tr><th>العضو</th><th>المسمى الوظيفي</th><th>لم تبدأ</th><th>قيد التنفيذ</th><th>متوقفة</th>
      <th>قيد المراجعة</th><th>متأخرة</th><th>أُنجزت في الفترة</th></tr></thead>
      <tbody>${members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.job_title || ROLE_LABELS[m.role])}</td>
        <td>${m.stats.todo}</td><td>${m.stats.in_progress}</td><td>${m.stats.blocked}</td><td>${m.stats.review}</td>
        <td>${m.stats.overdue}</td><td>${m.stats.done_in_period}</td></tr>`).join('')}</tbody></table>

    <h2>تفاصيل المهام لكل عضو</h2>
    ${members.filter((m) => byMember.get(m.id).length).map((m) => `<div class="member">
      <h3>${esc(m.name)}${m.job_title ? ` — ${esc(m.job_title)}` : ''}</h3>
      <table><thead><tr><th>المهمة</th><th>المشروع</th><th>الحالة</th><th>الملاحظة / السبب</th><th>الأولوية</th><th>الموعد النهائي</th></tr></thead>
        <tbody>${byMember.get(m.id).map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.project_name)}</td>
          <td>${statusPill(t.status)}</td><td>${esc(t.status_note || '—')}</td><td>${PRIORITY_LABELS[t.priority]}</td>
          <td>${t.deadline ? esc(fmtDate(t.deadline)) : '—'}${t.overdue ? ' (متأخرة)' : ''}</td></tr>`).join('')}</tbody></table>
    </div>`).join('') || '<p>لا توجد مهام مفتوحة أو منجزة خلال الفترة.</p>'}

    <h2>التقارير المرفوعة خلال الفترة</h2>
    ${reports.length ? reports.map((r) => `<div class="report-box">
      <strong>${esc(r.title)}</strong>
      <div class="small">${esc(r.sender_name)} إلى ${esc(r.recipient_name)} · ${esc(fmtDateTime(r.created_at))}</div>
      <div class="pre" style="margin-top:4px">${esc(r.body)}</div>
      ${r.status_summary ? `<div style="margin-top:4px">${summaryPills(r.status_summary)}</div>` : ''}
    </div>`).join('') : '<p>لم تُرفع تقارير خلال هذه الفترة.</p>'}

    <h2>طلبات المتطلبات</h2>
    <p>إجمالي الطلبات: ${requests.total} — قيد الانتظار: ${requests.pending} — مقبولة: ${requests.approved} — مرفوضة: ${requests.rejected}</p>

    <div class="foot">صادر عن منصة ابتكار لإدارة الأعمال — Ebtikar Software Solutions</div>
  </div>`;
  await Promise.all($$('img', root).map((img) => img.decode().catch(() => {})));
  await document.fonts.ready;
  const title = document.title;
  document.title = `Ebtikar-Team-Report-${isoDay(new Date())}`;
  window.print();
  document.title = title;
}

// ---------------------------------------------------------------------------
// Excel workbook
// ---------------------------------------------------------------------------

function teamWorkbook(data) {
  const { members, tasks, reports, totals } = data;
  return buildXlsx([
    {
      name: 'معلومات التقرير',
      widths: [28, 50],
      rows: [
        ['البند', 'القيمة'],
        ['عنوان التقرير', 'تقرير أداء الفريق'],
        ['الفترة', `من ${fmtDate(data.period.from)} إلى ${fmtDate(data.period.to)}`],
        ['أعدّه', data.generated_by.name],
        ['تاريخ الإصدار', fmtDateTime(data.generated_at)],
        ['أعضاء الفريق', totals.members],
        ['مهام مفتوحة', totals.total],
        ['مهام متوقفة', totals.blocked],
        ['مهام متأخرة', totals.overdue],
        ['أُنجزت خلال الفترة', totals.done_in_period],
        ['تقارير مرفوعة', totals.reports],
      ],
    },
    {
      name: 'ملخص الفريق',
      widths: [24, 24, 22, 10, 12, 10, 13, 10, 10, 16],
      rows: [
        ['العضو', 'المسمى الوظيفي', 'المسؤول المباشر', 'لم تبدأ', 'قيد التنفيذ', 'متوقفة', 'قيد المراجعة', 'متأخرة', 'مكتملة', 'أُنجزت في الفترة'],
        ...members.map((m) => [m.name, m.job_title || ROLE_LABELS[m.role], m.supervisor_name || '', m.stats.todo,
          m.stats.in_progress, m.stats.blocked, m.stats.review, m.stats.overdue, m.stats.done, m.stats.done_in_period]),
      ],
    },
    {
      name: 'المهام',
      widths: [22, 34, 22, 14, 40, 10, 20, 10],
      rows: [
        ['العضو', 'المهمة', 'المشروع', 'الحالة', 'الملاحظة / السبب', 'الأولوية', 'الموعد النهائي', 'متأخرة'],
        ...tasks.map((t) => [t.assignee_name, t.title, t.project_name, STATUS_LABELS[t.status], t.status_note || '',
          PRIORITY_LABELS[t.priority], t.deadline ? fmtDateTime(t.deadline) : '', t.overdue ? 'نعم' : 'لا']),
      ],
    },
    {
      name: 'التقارير',
      widths: [20, 20, 20, 30, 70, 10, 10],
      rows: [
        ['التاريخ', 'المرسل', 'المرسل إليه', 'العنوان', 'نص التقرير', 'متوقفة', 'متأخرة'],
        ...reports.map((r) => [fmtDateTime(r.created_at), r.sender_name, r.recipient_name, r.title, r.body,
          r.status_summary ? r.status_summary.blocked : '', r.status_summary ? r.status_summary.overdue : '']),
      ],
    },
  ]);
}
