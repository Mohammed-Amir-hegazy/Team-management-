import {
  state, $, esc, icon, mark, api, render, setTitle, setFab, taskList, greeting, fmtLongDate, plural, TASKS_N,
} from '../core.js';
import { taskFormModal } from './tasks.js';
import { composeReport } from './reports.js';
import { newRequestModal } from './asks.js';
import { newProjectModal } from './projects.js';

// What needs the person now, each as one line that opens where it is dealt with.
function todoRows(d, teamAlerts) {
  const s = d.my_tasks_by_status;
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const dueToday = d.upcoming.filter((t) => new Date(t.deadline) <= endOfDay).length;
  return [
    ['red', 'clock', 'مهام متأخرة عن موعدها', 'حدّث حالتها، أو اذكر سبب التأخير', d.overdue.length, '#/tasks?status=overdue'],
    ['red', 'alert', 'مهام متوقفة لديك', 'اطلب ما تحتاجه لتكمل العمل', s.blocked || 0, '#/tasks?status=blocked'],
    ['amber', 'calendar', 'مستحقة اليوم', 'موعدها النهائي ينتهي اليوم', dueToday, '#/tasks'],
    ['navy', 'box', 'طلبات تنتظر ردك', 'وافق عليها أو أضفها إلى مهامك أو اعتذر عنها', (d.pending_requests || 0) + (d.pending_asks || 0), '#/requests'],
    ['blue', 'report', 'تقارير لم تقرأها', 'تقارير وصلتك من فريقك', d.unread_reports || 0, '#/reports'],
    state.me.has_team ? ['red', 'users', 'تنبيهات الفريق', 'مهام متوقفة أو متأخرة لدى فريقك', teamAlerts.length, '#/team'] : null,
  ].filter((r) => r && r[4] > 0);
}

// First steps for a new company, for its owner and admins, until done or hidden.
function setupCard(setup) {
  if (!setup) return '';
  const key = `setupHidden:${state.me.company_id}`;
  try { if (localStorage.getItem(key)) return ''; } catch { /* show it */ }
  const steps = [
    [setup.users > 1, 'أضف فريقك', 'حسابات الموظفين ومسؤول كل منهم', '#/people?add=1'],
    [setup.projects > 0, 'أنشئ أول مشروع', 'ثم أضف إليه المهام وأعضاء الفريق', '#new-project'],
    [setup.brand > 0, 'أضف شعار الشركة وألوانها', 'لتظهر في التقارير وملفات PDF', '#/brand'],
    [setup.users > 0 && !setup.no_gender, 'حدّد نوع كل مستخدم', 'لمخاطبة كل شخص بالصيغة الصحيحة', '#/people?genders=1'],
  ];
  const done = steps.filter(([ok]) => ok).length;
  if (done === steps.length) return '';
  return `<section class="card setup">
    <div class="card-head"><h2>ابدأ من هنا</h2><span class="pill blue plain">${done} من ${steps.length}</span>
      <div class="actions"><button class="btn sm ghost" id="hide-setup">إخفاء</button></div></div>
    <div class="progress"><div style="width:${Math.round((done / steps.length) * 100)}%"></div></div>
    <div class="setup-steps">${steps.map(([ok, label, hint, href], i) => `<a class="setup-step ${ok ? 'done' : ''}" href="${href}">
      <span class="n">${ok ? icon('check') : i + 1}</span><span class="grow"><strong>${label}</strong><small>${hint}</small></span></a>`).join('')}</div>
  </section>`;
}

export async function viewDashboard() {
  setTitle('الرئيسية');
  const d = await api('GET', '/api/dashboard');
  const me = state.me;
  const s = d.my_tasks_by_status;
  const open = (s.todo || 0) + (s.in_progress || 0) + (s.blocked || 0) + (s.review || 0);
  const attention = [...d.overdue, ...d.upcoming];

  // Team alerts: blocked or late work below me, each task once.
  const seen = new Set();
  const teamAlerts = [...d.team_blocked, ...d.team_overdue].filter((t) => !seen.has(t.id) && seen.add(t.id));
  const todo = todoRows(d, teamAlerts);

  const summary = todo.length
    ? `لديك ${todo.length === 1 ? 'أمر واحد يحتاج' : `${todo.length} أمور تحتاج`} إلى انتباهك اليوم.`
    : open ? `المهام المفتوحة لديك: ${plural(open, TASKS_N)}، ولا يوجد ما يحتاج إلى إجراء عاجل.` : 'لا يوجد ما يحتاج إلى إجراء منك الآن.';
  const stats = [
    ['todo', 'لم تبدأ'], ['in_progress', 'قيد التنفيذ'], ['review', 'قيد المراجعة'], ['done', 'مكتملة'],
  ];

  const el = render(`
    <section class="hero compact">
      ${mark('watermark')}
      <div class="small" style="color:#B9B6FF">${esc(fmtLongDate())}</div>
      <h1>${greeting()}، ${esc(me.name.split(' ')[0])}</h1>
      <p>${esc(summary)}</p>
      <div class="quick">
        <button class="btn accent" id="q-task">${icon('plus')}مهمة جديدة</button>
        <button class="btn ghost" id="q-ask">${icon('box')}إرسال طلب</button>
        ${(me.chain || []).length ? `<button class="btn ghost" id="q-report">${icon('send')}إرسال تقرير</button>` : ''}
      </div>
    </section>

    ${setupCard(d.setup)}

    <section class="card todo">
      <div class="card-head"><h2>المطلوب منك الآن</h2></div>
      ${todo.length ? `<div class="todo-list">${todo.map(([tone, ic, title, hint, n, href]) => `<a class="todo-row ${tone}" href="${href}">
        <span class="ic">${icon(ic)}</span>
        <span class="grow"><strong>${title}</strong><small>${hint}</small></span>
        <span class="n">${n}</span>${icon('next')}</a>`).join('')}</div>`
    : `<div class="all-clear">${icon('check')}<div><strong>أنت على اطلاع بكل شيء</strong>
        <div class="muted small">لا توجد مهام متأخرة أو متوقفة، ولا طلبات أو تقارير تنتظرك.</div></div></div>`}
    </section>

    <nav class="stat-strip" aria-label="مهامي حسب الحالة">${stats.map(([k, label]) => `<a href="#/tasks?status=${k}" class="s-${k}">
      <b>${s[k] || 0}</b><span>${label}</span></a>`).join('')}</nav>

    <div class="grid two">
      <section class="card">
        <div class="card-head"><h2>مهامي القريبة</h2>
          <div class="actions"><a class="btn sm ghost" href="#/tasks">جميع مهامي</a></div></div>
        ${taskList(attention, { emptyTitle: 'لا توجد مهام قريبة', emptyText: 'لا توجد مهام متأخرة أو مستحقة خلال الأيام السبعة القادمة.' })}
      </section>
      ${me.has_team ? `
      <section class="card">
        <div class="card-head"><h2>تنبيهات الفريق</h2>
          <div class="actions"><a class="btn sm ghost" href="#/team">متابعة الفريق</a></div></div>
        ${taskList(teamAlerts, { showAssignee: true, emptyTitle: 'سير العمل منتظم', emptyText: 'لا توجد مهام متوقفة أو متأخرة لدى فريقك.' })}
      </section>` : ''}
    </div>`);

  const newTask = () => taskFormModal({});
  $('#q-task', el).addEventListener('click', newTask);
  $('#q-ask', el).addEventListener('click', () => newRequestModal());
  const rep = $('#q-report', el);
  if (rep) rep.addEventListener('click', () => composeReport({}));
  const hide = $('#hide-setup', el);
  if (hide) hide.addEventListener('click', () => {
    try { localStorage.setItem(`setupHidden:${me.company_id}`, '1'); } catch { /* ignore */ }
    hide.closest('.setup').remove();
  });
  const firstProject = $('a[href="#new-project"]', el);
  if (firstProject) firstProject.addEventListener('click', (e) => { e.preventDefault(); newProjectModal(); });
  setFab('مهمة جديدة', newTask);
}
