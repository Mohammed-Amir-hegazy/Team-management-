import {
  state, $, esc, icon, api, render, setTitle, setFab, toast, openModal,
  STATUS_LABELS, STATUSES, statusPill, avatar, tabs, onTabs, remember, relTime, fmtDateTime, fmtDate,
  deadlineInfo, emptyState, stackBar, plural, TASKS_N,
} from '../core.js';

// ---------------------------------------------------------------------------
// Work-status snapshot (attached to every report)
// ---------------------------------------------------------------------------

export function summaryPills(s) {
  if (!s) return '';
  return `${s.total ? `<span class="pill gray plain">${plural(s.total, TASKS_N)}</span>` : '<span class="pill gray plain">لا توجد مهام</span>'}
    ${STATUSES.map((k) => (s[k] ? `<span class="pill st-${k}">${STATUS_LABELS[k]} ${s[k]}</span>` : '')).join('')}
    ${s.overdue ? `<span class="pill amber plain">${icon('clock')} ${s.overdue} متأخرة</span>` : ''}`;
}

export function snapshotHtml(snap, title = 'حالة العمل المرفقة') {
  if (!snap) return '';
  return `<section class="snapshot">
    <div class="row wrap"><h3 style="margin:0">${icon('layers')} ${esc(title)}</h3>
      <span class="muted small" style="margin-inline-start:auto">كما كانت في ${esc(fmtDateTime(snap.generated_at))}</span></div>
    <div class="sum">${summaryPills(snap.summary)}</div>
    ${snap.tasks.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>المهمة</th><th>المشروع</th><th>الحالة</th><th>الملاحظة / السبب</th><th>الموعد النهائي</th></tr></thead>
      <tbody>${snap.tasks.map((t) => {
        const dl = deadlineInfo(t.deadline, t.status);
        return `<tr class="link" data-href="#/tasks/${t.id}"><td><strong>${esc(t.title)}</strong></td><td>${esc(t.project_name)}</td>
          <td>${statusPill(t.status)}</td><td>${esc(t.status_note || '—')}</td>
          <td class="${dl.late ? 'late' : ''} nowrap">${t.deadline ? esc(fmtDate(t.deadline)) : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
    ${snap.team && snap.team.length ? `<h3 style="margin-top:1rem">ملخص الفريق</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>العضو</th><th>التوزيع</th><th class="num">قيد التنفيذ</th><th class="num">متوقفة</th><th class="num">متأخرة</th><th class="num">مكتملة</th></tr></thead>
        <tbody>${snap.team.map((m) => `<tr><td><div class="row">${avatar(m.name, m.id, 'sm')}<div><div>${esc(m.name)}</div>
          <div class="muted small">${esc(m.job_title || '')}</div></div></div></td>
          <td style="min-width:110px">${stackBar(m)}</td>
          <td class="num">${m.in_progress}</td><td class="num ${m.blocked ? 'late' : ''}">${m.blocked}</td>
          <td class="num ${m.overdue ? 'late' : ''}">${m.overdue}</td><td class="num">${m.done}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
  </section>`;
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
  const { form } = openModal({
    title: 'تقرير جديد',
    wide: true,
    body: `
      <div class="callout blue">${avatar(me.supervisor_name, me.supervisor_id, 'sm')}<div>يُرسل هذا التقرير إلى
        <strong>${esc(me.supervisor_name)}</strong> بصفته مسؤولك المباشر${label ? ` · بخصوص ${esc(label)}` : ''}.</div></div>
      ${projects.length ? `<div class="field"><label>نطاق التقرير</label><select name="scope">
        <option value="">جميع أعمالي</option>
        ${projects.map((p) => `<option value="${p.id}">مشروع: ${esc(p.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>عنوان التقرير</label><input name="title" required value="تقرير حالة العمل — ${esc(fmtDate(new Date().toISOString()))}"></div>
      <div class="field"><label>نص التقرير</label><textarea name="body" rows="6" required
        placeholder="ما الذي أُنجز؟ وما العوائق الحالية؟ وما الخطوات القادمة؟"></textarea></div>
      <label class="switch" style="margin-bottom:.7rem"><input type="checkbox" name="include_status" checked>
        إرفاق حالة العمل تلقائيًا (المهام وحالاتها وأسباب التوقف${me.has_team ? ' وملخص الفريق' : ''})</label>
      <div id="snap-preview" class="snapshot"><div class="skeleton" style="height:22px;width:60%"></div></div>`,
    submitLabel: 'إرسال التقرير',
    onSubmit: async (d) => {
      const scope = d.scope ? Number(d.scope) : projectId;
      const { report } = await api('POST', '/api/reports', {
        title: d.title, body: d.body, project_id: scope, task_id: taskId, include_status: d.include_status,
      });
      toast('تم إرسال التقرير بنجاح');
      location.hash = `#/reports/${report.id}`;
    },
  });

  const preview = $('#snap-preview', form);
  const load = async () => {
    const scope = form.elements.scope ? form.elements.scope.value : projectId;
    const qs = new URLSearchParams();
    if (taskId) qs.set('task_id', taskId);
    else if (scope) qs.set('project_id', scope);
    try {
      const { snapshot: s } = await api('GET', `/api/reports/preview?${qs}`);
      preview.innerHTML = `<div class="muted small" style="margin-bottom:.3rem">سيُرفق مع التقرير:</div>
        <div class="sum" style="margin:0">${summaryPills(s.summary)}
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

export async function viewReport({ id }) {
  const { report: r, forwarded_from: f, permissions: can } = await api('GET', `/api/reports/${id}`);
  setTitle('تقرير');
  const el = render(`
    <div class="page-head">
      <div class="titles"><a class="crumb" href="#/reports">${icon('back')}التقارير</a><h1>${esc(r.title)}</h1></div>
      <div class="actions">
        ${can.reply ? `<button class="btn" id="reply">${icon('reply')}رد</button>` : ''}
        ${can.forward ? `<button class="btn ghost" id="forward">${icon('forward')}إحالة إلى ${esc(state.me.supervisor_name)}</button>` : ''}
      </div>
    </div>
    <article class="card">
      <div class="row wrap" style="margin-bottom:1rem">${avatar(r.sender_name, r.sender_id)}
        <div class="grow"><div class="title"><strong>${esc(r.sender_name)}</strong> <span class="muted small">${esc(r.sender_job_title || '')}</span></div>
          <div class="muted small">إلى ${esc(r.recipient_name)} · ${esc(fmtDateTime(r.created_at))}
            ${r.project_id ? ` · <a href="#/projects/${r.project_id}">${esc(r.project_name)}</a>` : ''}
            ${r.task_id ? ` · <a href="#/tasks/${r.task_id}">${esc(r.task_title)}</a>` : ''}</div></div></div>
      <div class="pre" style="font-size:1.02rem">${esc(r.body)}</div>
      ${r.snapshot ? `<div style="margin-top:1.2rem">${snapshotHtml(r.snapshot)}</div>` : ''}
      ${f ? `<div class="card" style="margin-top:1.2rem;background:var(--surface-2);box-shadow:none">
        <div class="muted small">التقرير الأصلي من ${esc(f.sender_name)} · ${esc(fmtDateTime(f.created_at))}</div>
        <h3>${esc(f.title)}</h3><div class="pre">${esc(f.body)}</div>
        ${f.snapshot ? `<div style="margin-top:1rem">${snapshotHtml(f.snapshot)}</div>` : ''}</div>` : ''}
      ${r.reply ? `<div class="callout green" style="margin-top:1.2rem">${icon('reply')}<div><strong>ردّ ${esc(r.recipient_name)}:</strong>
        <div class="pre">${esc(r.reply)}</div><div class="small">${esc(fmtDateTime(r.replied_at))}</div></div></div>` : ''}
    </article>`);

  if (can.reply) $('#reply', el).addEventListener('click', () => openModal({
    title: 'الرد على التقرير',
    body: '<div class="field"><label>نص الرد</label><textarea name="reply" required></textarea></div>',
    submitLabel: 'إرسال الرد',
    onSubmit: async (d) => {
      await api('POST', `/api/reports/${r.id}/reply`, d);
      toast('تم إرسال الرد');
      viewReport({ id });
    },
  }));
  if (can.forward) $('#forward', el).addEventListener('click', () => openModal({
    title: `إحالة التقرير إلى ${state.me.supervisor_name}`,
    body: '<div class="field"><label>تعليقك <span class="hint">(اختياري)</span></label><textarea name="note"></textarea></div>',
    submitLabel: 'إحالة',
    onSubmit: async (d) => {
      const res = await api('POST', `/api/reports/${r.id}/forward`, d);
      toast('تمت إحالة التقرير');
      location.hash = `#/reports/${res.report_id}`;
    },
  }));
  setFab(null);
}
