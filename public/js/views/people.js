import {
  state, $, $$, esc, icon, api, render, setTitle, setFab, toast, openModal,
  ROLE_LABELS, ORG_ROLES, avatar, emptyState,
} from '../core.js';
import { openReminder } from '../remind.js';
import { openWhatsApp, generalMessage } from '../whatsapp.js';

// Who I may remind: people below me (down) and my supervisor chain (up).
function relationTo(u) {
  if (u.in_my_team) return 'down';
  if ((state.me.chain || []).some((c) => c.id === u.id)) return 'up';
  return null;
}

const ROLE_HINTS = {
  owner: 'أعلى مستوى في الشركة؛ ويتبعه من هم في قمة الهيكل حاليًا',
  manager: 'يشرف على قادة الفرق ويتابع أعمالهم',
  team_leader: 'يقود فريقًا ويتابع مهامه وتقاريره',
  employee: 'ينفّذ المهام ويرفع التقارير',
  admin: 'ينشئ الحسابات ويدير الأدوار والصلاحيات',
};
const rank = (role) => ORG_ROLES.indexOf(role);
const primaryOf = (roles) => ORG_ROLES.find((r) => roles.includes(r));

function personCard(u, admin) {
  return `<div class="person ${u.id === state.me.id ? 'me' : ''} ${u.active ? '' : 'off'}">
    ${avatar(u.name, u.id)}
    <div class="who grow">
      <div class="n">${esc(u.name)}${u.id === state.me.id ? ' <span class="pill blue plain">أنت</span>' : ''}${u.active ? '' : ' <span class="pill red plain">موقوف</span>'}</div>
      <div class="t">${esc(u.job_title || ROLE_LABELS[u.role])}</div>
      <div class="roles">${u.roles.map((r) => `<span class="pill ${r === 'admin' ? 'navy' : 'gray'} plain">${ROLE_LABELS[r]}</span>`).join('')}</div>
    </div>
    <div class="row" style="gap:.3rem">
      ${u.phone && u.id !== state.me.id ? `<button class="icon-btn wa" data-wa="${u.id}" aria-label="مراسلة ${esc(u.name)} عبر واتساب">${icon('whatsapp')}</button>` : ''}
      ${u.active && relationTo(u) ? `<button class="icon-btn" data-remind="${u.id}" aria-label="تذكير ${esc(u.name)}">${icon('bell')}</button>` : ''}
      ${admin && u.manageable ? `<button class="icon-btn" data-edit="${u.id}" aria-label="تعديل ${esc(u.name)}">${icon('edit')}</button>` : ''}
    </div>
  </div>`;
}

export async function viewPeople() {
  const { users, can_manage_accounts: admin, seats } = await api('GET', '/api/users');
  setTitle(admin ? 'المستخدمين' : 'الهيكل الوظيفي');
  const byId = new Map(users.map((u) => [u.id, u]));
  const children = new Map();
  const roots = [];
  for (const u of users) {
    if (u.supervisor_id && byId.has(u.supervisor_id)) {
      if (!children.has(u.supervisor_id)) children.set(u.supervisor_id, []);
      children.get(u.supervisor_id).push(u);
    } else {
      roots.push(u);
    }
  }
  const tree = (u) => `<li>${personCard(u, admin)}${children.has(u.id)
    ? `<ul>${children.get(u.id).map(tree).join('')}</ul>` : ''}</li>`;
  const active = users.filter((u) => u.active).length;

  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>${admin ? 'المستخدمين' : 'الهيكل الوظيفي'}</h1>
        <div class="sub">${admin && seats.total ? `${seats.used} من ${seats.total} حسابات مستخدمة في باقتكم` : `${active} حساب نشط`} · تُرسل التقارير والطلبات إلى المسؤول المباشر فقط</div></div>
      <div class="actions">${admin ? `<button class="btn" id="add-user">${icon('plus')}إضافة مستخدم</button>` : ''}</div>
    </div>
    ${!admin ? `<div class="callout blue">${icon('shield')}<div>إنشاء الحسابات وتعديل الأدوار من صلاحيات صاحب الشركة ومسؤول النظام.</div></div>` : ''}
    ${admin && !users.some((u) => u.role === 'owner' && u.active) ? `<div class="callout amber">${icon('alert')}<div>لم يُضف حساب صاحب الشركة بعد. يمكنك إضافته من «إضافة مستخدم» باختيار دور «صاحب الشركة»، وسيتبعه من هم في قمة الهيكل حاليًا.</div></div>` : ''}
    <div class="toolbar"><div class="input-icon">${icon('search')}<input id="q" type="search" placeholder="ابحث بالاسم أو المسمى الوظيفي"></div></div>
    <section class="card">
      <div class="org" id="org"><ul>${roots.map(tree).join('')}</ul></div>
      <div id="results" class="hidden stack" style="gap:.5rem"></div>
    </section>`);

  const bindEdit = (root) => {
    $$('[data-edit]', root).forEach((b) => b.addEventListener('click', () => userModal(users, byId.get(Number(b.dataset.edit)))));
    $$('[data-remind]', root).forEach((b) => b.addEventListener('click', () => {
      const u = byId.get(Number(b.dataset.remind));
      openReminder({ person: u, relation: relationTo(u) });
    }));
    $$('[data-wa]', root).forEach((b) => b.addEventListener('click', () => {
      const u = byId.get(Number(b.dataset.wa));
      openWhatsApp(u.phone, generalMessage(u, relationTo(u) || 'up', ''));
    }));
  };
  bindEdit(el);
  $('#q', el).addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const results = $('#results', el);
    $('#org', el).classList.toggle('hidden', !!q);
    results.classList.toggle('hidden', !q);
    if (!q) return;
    const found = users.filter((u) => u.name.includes(q) || (u.job_title || '').includes(q) || u.email.includes(q.toLowerCase()));
    results.innerHTML = found.length ? found.map((u) => personCard(u, admin)).join('') : emptyState('لا توجد نتائج مطابقة');
    bindEdit(results);
  });
  if (admin) {
    const add = () => userModal(users, null);
    $('#add-user', el).addEventListener('click', add);
    setFab('إضافة مستخدم', add);
  } else {
    setFab(null);
  }
}

function userModal(users, user) {
  const editing = !!user;
  const isOwner = editing && user.role === 'owner';
  const roles = editing ? user.roles : ['employee'];
  const titles = [...new Set(users.map((u) => u.job_title).filter(Boolean))];
  // A company registered by its system admin may still be without an owner; one can be added.
  const hasOwner = users.some((u) => u.role === 'owner' && u.active);
  const canAddOwner = !editing && !hasOwner;

  // Never offer someone's own subtree as their supervisor.
  const below = new Set();
  if (editing) {
    const stack = [user.id];
    while (stack.length) {
      const id = stack.pop();
      for (const u of users) if (u.supervisor_id === id && !below.has(u.id)) { below.add(u.id); stack.push(u.id); }
    }
  }
  const supervisorOptions = (level, selected) => users
    .filter((u) => u.active && rank(u.role) < rank(level) && (!editing || (u.id !== user.id && !below.has(u.id))))
    .sort((a, b) => rank(a.role) - rank(b.role))
    .map((u) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name)} — ${esc(u.job_title || ROLE_LABELS[u.role])}</option>`)
    .join('');

  const { form } = openModal({
    title: editing ? `تعديل بيانات ${user.name}` : 'إضافة مستخدم جديد',
    wide: true,
    body: `
      <div class="fields">
        <div class="field"><label>الاسم الكامل</label><input name="name" required value="${esc(editing ? user.name : '')}"></div>
        <div class="field"><label>المسمى الوظيفي</label><input name="job_title" list="titles" value="${esc(editing ? user.job_title : '')}" placeholder="مثال: مصمم واجهات، محاسب، مطوّر برمجيات">
          <datalist id="titles">${titles.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
      </div>
      <div class="fields">
        <div class="field"><label>البريد الإلكتروني</label><input name="email" type="email" dir="ltr" required value="${esc(editing ? user.email : '')}"></div>
        <div class="field"><label>رقم واتساب <span class="hint">(مع رمز الدولة)</span></label><input name="phone" type="tel" dir="ltr" value="${esc(editing && user.phone ? `+${user.phone}` : '')}" placeholder="2010xxxxxxxx+"></div>
      </div>
      <div class="fields">
        <div class="field"><label>${editing ? 'كلمة مرور جديدة <span class="hint">(اتركها فارغة للإبقاء على الحالية)</span>' : 'كلمة المرور المبدئية'}</label>
          <input name="password" type="text" dir="ltr" ${editing ? '' : 'required'} autocomplete="new-password"></div>
      </div>
      ${isOwner ? '' : `
      <div class="field"><label>الأدوار <span class="hint">— يمكن اختيار أكثر من دور، ويُحدَّد المستوى الوظيفي بأعلى دور مختار</span></label>
        <div class="checks cols">${[...(canAddOwner ? ['owner'] : []), 'manager', 'team_leader', 'employee', 'admin'].map((r) => `<label class="check">
          <input type="checkbox" name="roles" value="${r}" data-multi ${roles.includes(r) ? 'checked' : ''}>
          <span class="grow">${ROLE_LABELS[r]}<small>${ROLE_HINTS[r]}</small></span></label>`).join('')}</div></div>
      <div class="field" data-supervisor><label>المسؤول المباشر</label><select name="supervisor_id"></select>
        <span class="hint">يرفع إليه الموظف تقاريره وطلباته مباشرة.</span></div>
      ${editing && user.id !== state.me.id ? `<label class="switch"><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> الحساب نشط</label>` : ''}`}`,
    submitLabel: editing ? 'حفظ التعديلات' : 'إنشاء الحساب',
    onSubmit: async (d) => {
      const body = { name: d.name, job_title: d.job_title, email: d.email, phone: d.phone };
      if (d.roles && d.roles.includes('owner')) {
        body.roles = ['owner'];
      } else if (!isOwner) {
        body.roles = d.roles;
        body.supervisor_id = Number(d.supervisor_id) || null;
        if (editing && d.active !== undefined) body.active = d.active;
      }
      if (d.password) body.password = d.password;
      if (editing) {
        await api('PATCH', `/api/users/${user.id}`, body);
        toast('تم حفظ التعديلات');
      } else {
        await api('POST', '/api/users', body);
        toast('تم إنشاء الحساب بنجاح');
      }
      window.dispatchEvent(new Event('refresh-view'));
    },
  });

  if (isOwner) return;
  const select = form.elements.supervisor_id;
  const refresh = () => {
    const chosen = $$('input[name=roles]:checked', form).map((i) => i.value);
    const asOwner = chosen.includes('owner');
    $$('input[name=roles]', form).forEach((i) => {
      if (i.value === 'owner') return;
      i.disabled = asOwner;
      if (asOwner) i.checked = false;
    });
    $('[data-supervisor]', form).classList.toggle('hidden', asOwner);
    if (asOwner) { select.disabled = true; return; }
    const level = primaryOf(chosen);
    const current = select.dataset.touched ? Number(select.value) : (editing ? user.supervisor_id : state.me.id);
    select.innerHTML = level ? supervisorOptions(level, current) : '';
    select.disabled = !level;
    if (!level) select.innerHTML = '<option value="">اختر مستوى وظيفيًا أولًا (مدير أو قائد فريق أو موظف)</option>';
    // Without an owner yet, anyone may sit at the top; they move under the owner once it is added.
    else if (!hasOwner) {
      select.insertAdjacentHTML('afterbegin', `<option value="" ${current && select.querySelector(`option[value="${current}"]`) ? '' : 'selected'}>
        بدون مسؤول مباشر — في قمة الهيكل لحين إضافة صاحب الشركة</option>`);
    } else if (!select.innerHTML) select.innerHTML = '<option value="">لا يوجد مسؤول مناسب لهذا المستوى؛ يُرجى إضافة شخص في مستوى أعلى أولًا</option>';
  };
  refresh();
  select.addEventListener('change', () => { select.dataset.touched = '1'; });
  $$('input[name=roles]', form).forEach((i) => i.addEventListener('change', refresh));
}
