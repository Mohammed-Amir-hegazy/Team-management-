import {
  state, $, $$, esc, icon, api, render, setTitle, setFab, toast, openModal, confirmDialog,
  STATUS_LABELS, STATUSES, PROJECT_STATUS, ROLE_LABELS,
  pill, avatar, taskList, emptyState, plural, TASKS_N, MEMBERS_N, ITEMS_N, remember,
} from '../core.js';
import { taskFormModal, sendRequirementsModal } from './tasks.js';
import { composeReport } from './reports.js';
import { recurringSection } from './recurring.js';

// Everyone can start a project; members can only be chosen from one's own team.
const canCreateProjects = () => true;

export async function viewProjects() {
  setTitle('المشاريع');
  const { projects } = await api('GET', '/api/projects');
  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>المشاريع</h1><div class="sub">${projects.length ? `${projects.length} مشروع متاح لك` : 'لا توجد مشاريع بعد'}</div></div>
      <div class="actions">${canCreateProjects() ? `<button class="btn" id="new-project">${icon('plus')}مشروع جديد</button>` : ''}</div>
    </div>
    ${projects.length > 3 ? `<div class="toolbar"><div class="input-icon">${icon('search')}<input id="q" type="search" placeholder="ابحث عن مشروع"></div></div>` : ''}
    ${projects.length ? `<div class="grid cards stagger">${projects.map((p, i) => {
      const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
      return `<article class="card link project" data-href="#/projects/${p.id}" data-name="${esc(p.name)}" style="--i:${Math.min(i, 12)}">
        <div class="row" style="align-items:flex-start">
          <div class="grow"><h3>${esc(p.name)}</h3><div class="muted small">بإشراف ${esc(p.creator_name)}</div></div>
          <div class="ring" data-p="${pct}" data-label="${pct}%"></div>
        </div>
        <p class="desc">${esc(p.description || 'لا يوجد وصف لهذا المشروع.')}</p>
        <div class="stats">
          ${pill(PROJECT_STATUS[p.status])}
          <span class="pill gray plain">${icon('tasks')} ${p.tasks_done}/${p.tasks_total}</span>
          <span class="pill gray plain">${icon('users')} ${p.members_count}</span>
          ${p.my_open_tasks ? `<span class="pill blue plain">لك ${plural(p.my_open_tasks, TASKS_N)}</span>` : ''}
          ${p.tasks_blocked ? `<span class="pill red plain">${p.tasks_blocked} متوقفة</span>` : ''}
          ${p.tasks_overdue ? `<span class="pill amber plain">${p.tasks_overdue} متأخرة</span>` : ''}
        </div>
      </article>`;
    }).join('')}</div>` : `<div class="card">${emptyState('لا توجد مشاريع متاحة لك',
      canCreateProjects() ? 'ابدأ بإنشاء أول مشروع وإضافة أعضاء فريقك إليه.' : 'ستظهر هنا المشاريع التي تُضاف إليها.')}</div>`}`);

  const q = $('#q', el);
  if (q) q.addEventListener('input', () => {
    $$('.project', el).forEach((c) => c.classList.toggle('hidden', q.value && !c.dataset.name.includes(q.value.trim())));
  });
  if (canCreateProjects()) {
    $('#new-project', el).addEventListener('click', newProjectModal);
    setFab('مشروع جديد', newProjectModal);
  }
}

async function newProjectModal() {
  const { users } = await api('GET', '/api/users');
  const team = users.filter((u) => u.in_my_team && u.active);
  openModal({
    title: 'مشروع جديد',
    body: `
      <div class="field"><label>اسم المشروع</label><input name="name" required placeholder="مثال: تطوير الموقع الإلكتروني"></div>
      <div class="field"><label>الوصف <span class="hint">(اختياري)</span></label><textarea name="description" placeholder="أهداف المشروع ونطاقه"></textarea></div>
      ${team.length ? `<div class="field"><label>أعضاء المشروع <span class="hint">(من فريقك)</span></label><div class="checks scroll">
        ${team.map((u) => `<label class="check"><input type="checkbox" name="member_ids" value="${u.id}" data-multi>
          ${avatar(u.name, u.id, 'sm')}<span class="grow">${esc(u.name)}<small>${esc(u.job_title || ROLE_LABELS[u.role])}</small></span></label>`).join('')}
      </div></div>` : ''}`,
    submitLabel: 'إنشاء المشروع',
    onSubmit: async (d) => {
      const { project } = await api('POST', '/api/projects', { ...d, member_ids: (d.member_ids || []).map(Number) });
      toast('تم إنشاء المشروع');
      location.hash = `#/projects/${project.id}`;
    },
  });
}

export async function viewProject({ id }) {
  const data = await api('GET', `/api/projects/${id}`);
  const { project: p, members, tasks, permissions: can } = data;
  setTitle(p.name);
  const filterKey = `projectFilter:${id}`;
  const filter = remember(filterKey) || 'all';
  const shown = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]));
  const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;

  const el = render(`
    <div class="page-head">
      <div class="titles">
        <a class="crumb" href="#/projects">${icon('back')}المشاريع</a>
        <h1>${esc(p.name)}</h1>
        <div class="row wrap" style="margin-top:.4rem;gap:.4rem">${pill(PROJECT_STATUS[p.status])}
          <span class="pill gray plain">بإشراف ${esc(p.creator_name)}</span></div>
      </div>
      <div class="actions">
        <button class="btn" id="new-task">${icon('plus')}مهمة جديدة</button>
        ${state.me.supervisor_id ? `<button class="btn ghost" id="project-report">${icon('send')}تقرير عن المشروع</button>` : ''}
        ${can.manage ? `<button class="btn ghost" id="edit-project">${icon('edit')}تعديل</button>
          <button class="btn ghost" id="delete-project" aria-label="حذف المشروع">${icon('trash')}</button>` : ''}
      </div>
    </div>

    <section class="card">
      <div class="row wrap" style="gap:1rem">
        <div class="grow" style="min-width:220px">
          <div class="row"><strong>نسبة الإنجاز</strong><span class="muted" style="margin-inline-start:auto">${p.tasks_done} من ${p.tasks_total}</span></div>
          <div class="progress" style="margin-top:.45rem"><div data-width="${pct}"></div></div>
        </div>
        <div class="row wrap" style="gap:.4rem">
          ${STATUSES.map((s) => (counts[s] ? `<span class="pill st-${s}">${STATUS_LABELS[s]} ${counts[s]}</span>` : '')).join('')}
          ${p.tasks_overdue ? `<span class="pill amber plain">${icon('clock')} ${p.tasks_overdue} متأخرة</span>` : ''}
        </div>
      </div>
      ${p.description ? `<p class="pre muted" style="margin:.9rem 0 0">${esc(p.description)}</p>` : ''}
    </section>

    ${can.send_requests ? `<div class="send-bar" style="margin-top:1rem">
      <div>${icon('box')} <strong>متطلبات المشروع:</strong> ${data.my_draft_requirements
        ? `لديك ${plural(data.my_draft_requirements, ITEMS_N)} جاهزة للإرسال من جميع المهام`
        : 'لا توجد متطلبات جديدة؛ أضفها من صفحة كل مهمة'}</div>
      <button class="btn" id="send-project-reqs" ${data.my_draft_requirements ? '' : 'disabled'}>${icon('send')}إرسال جميع متطلبات المشروع</button>
    </div>` : ''}

    <div class="grid side" style="margin-top:1rem">
      <section class="card">
        <div class="card-head"><h2>المهام</h2></div>
        <div class="chips" style="margin-bottom:.9rem">
          <button class="chip ${filter === 'all' ? 'active' : ''}" data-filter="all">الكل <span class="n">${tasks.length}</span></button>
          ${STATUSES.map((s) => `<button class="chip ${filter === s ? 'active' : ''}" data-filter="${s}">${STATUS_LABELS[s]} <span class="n">${counts[s]}</span></button>`).join('')}
        </div>
        ${taskList(shown, { showProject: false, showAssignee: true, emptyTitle: tasks.length ? 'لا توجد مهام بهذه الحالة' : 'لا توجد مهام بعد', emptyText: tasks.length ? '' : 'أضف أول مهمة لهذا المشروع.' })}
      </section>
      <aside class="card">
        <div class="card-head"><h3>الأعضاء</h3><span class="muted small">${plural(members.length, MEMBERS_N)}</span>
          <div class="actions">${can.add_members && data.addable_users.length ? `<button class="btn sm subtle" id="add-member">${icon('plus')}إضافة</button>` : ''}</div></div>
        <div class="list">${members.map((m) => `<div class="item">${avatar(m.name, m.id, 'sm')}
          <div class="grow"><div class="title">${esc(m.name)}</div><div class="meta">${esc(m.job_title || ROLE_LABELS[m.role])}</div></div>
          ${m.removable && m.id !== p.created_by ? `<button class="icon-btn" data-remove-member="${m.id}" aria-label="إزالة ${esc(m.name)}">${icon('x')}</button>` : ''}
        </div>`).join('')}</div>
      </aside>
    </div>
    <section class="card" id="recurring-box" style="margin-top:1rem"></section>`);
  recurringSection($('#recurring-box', el), p, can.manage);

  $$('[data-filter]', el).forEach((b) => b.addEventListener('click', () => {
    remember(filterKey, b.dataset.filter);
    viewProject({ id });
  }));
  const addTask = () => taskFormModal({ projectId: p.id });
  $('#new-task', el).addEventListener('click', addTask);
  setFab('مهمة جديدة', addTask);
  const rep = $('#project-report', el);
  if (rep) rep.addEventListener('click', () => composeReport({ project_id: p.id, label: `مشروع ${p.name}` }));
  const send = $('#send-project-reqs', el);
  if (send) send.addEventListener('click', () => sendRequirementsModal(
    `/api/projects/${p.id}/requirements/send`, data.my_draft_requirements, () => viewProject({ id })));

  const addBtn = $('#add-member', el);
  if (addBtn) addBtn.addEventListener('click', () => openModal({
    title: 'إضافة أعضاء إلى المشروع',
    body: `<div class="checks scroll">${data.addable_users.map((u) => `<label class="check">
      <input type="checkbox" name="user_ids" value="${u.id}" data-multi>${avatar(u.name, u.id, 'sm')}
      <span class="grow">${esc(u.name)}<small>${esc(u.job_title || ROLE_LABELS[u.role])}</small></span></label>`).join('')}</div>`,
    submitLabel: 'إضافة',
    onSubmit: async (d) => {
      const ids = (d.user_ids || []).map(Number);
      if (!ids.length) throw new Error('يُرجى اختيار عضو واحد على الأقل');
      for (const uid of ids) await api('POST', `/api/projects/${p.id}/members`, { user_id: uid });
      toast('تمت إضافة الأعضاء');
      viewProject({ id });
    },
  }));
  $$('[data-remove-member]', el).forEach((b) => b.addEventListener('click', () => confirmDialog('هل تريد إزالة هذا العضو من المشروع؟', async () => {
    await api('DELETE', `/api/projects/${p.id}/members/${b.dataset.removeMember}`);
    toast('تمت إزالة العضو');
    viewProject({ id });
  }, 'إزالة')));

  if (can.manage) {
    $('#edit-project', el).addEventListener('click', () => openModal({
      title: 'تعديل المشروع',
      body: `
        <div class="field"><label>اسم المشروع</label><input name="name" value="${esc(p.name)}" required></div>
        <div class="field"><label>الوصف</label><textarea name="description">${esc(p.description)}</textarea></div>
        <div class="field"><label>حالة المشروع</label><select name="status">
          ${Object.entries(PROJECT_STATUS).map(([k, [l]]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>`,
      submitLabel: 'حفظ التعديلات',
      onSubmit: async (d) => {
        await api('PATCH', `/api/projects/${p.id}`, d);
        toast('تم حفظ التعديلات');
        viewProject({ id });
      },
    }));
    $('#delete-project', el).addEventListener('click', () => confirmDialog(
      'سيؤدي حذف المشروع إلى حذف جميع مهامه وطلباته نهائيًا. هل تريد المتابعة؟', async () => {
        await api('DELETE', `/api/projects/${p.id}`);
        toast('تم حذف المشروع');
        location.hash = '#/projects';
      }, 'حذف المشروع'));
  }
}
