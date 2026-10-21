import {
  state, $, esc, icon, mark, api, render, setTitle, setFab, kpi, taskList, greeting, fmtLongDate, plural, TASKS_N,
} from '../core.js';
import { taskFormModal } from './tasks.js';
import { composeReport } from './reports.js';

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

  let summary = open ? `المهام المفتوحة لديك: ${plural(open, TASKS_N)}` : 'لا توجد لديك مهام مفتوحة حاليًا';
  if (d.overdue.length) summary += `، والمتأخر منها عن موعده النهائي: ${plural(d.overdue.length, TASKS_N)}`;
  summary += '.';

  const el = render(`
    <section class="hero">
      ${mark('watermark')}
      <div class="small" style="color:#B9B6FF">${esc(fmtLongDate())}</div>
      <h1>${greeting()}، ${esc(me.name.split(' ')[0])}</h1>
      <p>${esc(summary)}</p>
      <div class="quick">
        <button class="btn accent" id="q-task">${icon('plus')}مهمة جديدة</button>
        ${me.supervisor_id ? `<button class="btn ghost" id="q-report">${icon('send')}إرسال تقرير</button>` : ''}
        ${me.has_team ? `<a class="btn ghost" href="#/team">${icon('chart')}متابعة الفريق</a>` : ''}
      </div>
    </section>

    <section class="kpis">
      ${kpi(s.in_progress, 'قيد التنفيذ', 'bolt', '', '#/tasks?status=in_progress')}
      ${kpi(s.blocked, 'متوقفة', 'alert', 'red', '#/tasks?status=blocked')}
      ${kpi(d.overdue.length, 'متأخرة عن موعدها', 'clock', 'amber', '#/tasks?status=overdue')}
      ${kpi(s.done, 'مكتملة', 'check', 'green', '#/tasks?status=done')}
      ${kpi(d.pending_requests, 'طلبات بانتظار ردك', 'box', 'navy', '#/requests')}
      ${kpi(d.unread_reports, 'تقارير غير مقروءة', 'report', '', '#/reports')}
    </section>

    <div class="grid two">
      <section class="card">
        <div class="card-head"><h2>مهام تحتاج إلى انتباهك</h2>
          <div class="actions"><a class="btn sm ghost" href="#/tasks">جميع مهامي</a></div></div>
        ${taskList(attention, { emptyTitle: 'لا توجد مهام عاجلة', emptyText: 'لا توجد مهام متأخرة أو مستحقة خلال الأيام السبعة القادمة.' })}
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
  const rep = $('#q-report', el);
  if (rep) rep.addEventListener('click', () => composeReport({}));
  setFab('مهمة جديدة', newTask);
}
