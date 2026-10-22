// The company's identity on its reports: logo, three colours and a font, with a live preview.
// Owners and system admins change it; everyone in the company sees it on reports, PDFs and Excel files.

import {
  state, $, $$, esc, icon, api, render, setTitle, setFab, toast, confirmDialog, busy, emptyState,
} from '../core.js';
import { DEFAULT_BRAND, WEB_FONTS, loadBrandFont, fontStack } from '../brand.js';
import { reportDocHtml } from './reports.js';

const COLORS = [
  ['primary_color', 'اللون الأساسي', 'رأس التقرير وعناوينه ورؤوس الجداول'],
  ['secondary_color', 'اللون الثانوي', 'تدرّج رأس التقرير'],
  ['accent_color', 'لون التمييز', 'شارة نوع التقرير وعلامات الأقسام'],
];

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('تعذّرت قراءة الملف'));
    reader.readAsDataURL(file);
  });
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.click();
  });
}

// Large raster logos are scaled down (PNG keeps transparency); SVGs are sent as they are.
async function logoDataUrl(file) {
  if (file.type === 'image/svg+xml' || file.size <= 550 * 1024) return readFile(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function sampleReport() {
  const me = state.me;
  const now = new Date().toISOString();
  return {
    id: 128, title: 'تقرير حالة العمل الأسبوعي', body: 'تم الانتهاء من المرحلة الأولى، والعمل جارٍ على المرحلة الثانية وفق الخطة.',
    created_at: now, sender_id: me.id, sender_name: me.name, sender_job_title: me.job_title,
    recipient_id: me.supervisor_id || 0, recipient_name: me.supervisor_name || 'المسؤول المباشر', read_at: now, images: [],
    snapshot: {
      generated_at: now,
      summary: { total: 12, todo: 2, in_progress: 5, review: 1, blocked: 1, done: 3, overdue: 1 },
      tasks: [
        { id: 1, title: 'تصميم الواجهة الرئيسية', project_name: 'الموقع الإلكتروني', status: 'in_progress', priority: 'high', deadline: now },
        { id: 2, title: 'مراجعة العقود', project_name: 'الشؤون القانونية', status: 'blocked', status_note: 'بانتظار التوقيع', priority: 'medium' },
        { id: 3, title: 'إعداد الميزانية', project_name: 'المالية', status: 'done', priority: 'low' },
      ],
    },
  };
}

export async function viewBrand() {
  setTitle('هوية الشركة');
  setFab(null);
  if (!state.me.is_admin) {
    render(`<div class="card">${emptyState('هذه الصفحة متاحة لصاحب الشركة ومسؤول النظام فقط')}</div>`);
    return;
  }
  let { brand } = await api('GET', '/api/company/brand');
  // The form's working copy; saved colours and font only change on "حفظ".
  const draft = {
    primary_color: brand.primary_color, secondary_color: brand.secondary_color, accent_color: brand.accent_color, font: brand.font,
  };

  const el = render(`
    <div class="page-head">
      <div class="titles"><h1>هوية الشركة</h1>
        <div class="sub">شعار ${esc(state.me.company.name || 'شركتكم')} وألوانها وخطها في التقارير وملفات PDF وExcel</div></div>
    </div>
    <div class="grid side brand-page">
      <section class="card stack">
        <div>
          <h3>الشعار</h3>
          <div class="logo-box" id="logo-box"></div>
          <div class="row wrap" style="gap:.5rem;margin-top:.6rem">
            <button class="btn subtle" id="logo-up">${icon('camera')}رفع الشعار</button>
            <button class="btn ghost danger-text" id="logo-del">${icon('trash')}إزالة</button>
          </div>
          <p class="hint">PNG أو JPG أو WebP أو SVG، ويُفضّل شعار بخلفية شفافة.</p>
        </div>

        <div>
          <h3>الألوان</h3>
          ${COLORS.map(([key, label, hint]) => `<div class="color-row">
            <input type="color" data-color="${key}" aria-label="${label}">
            <div class="grow"><strong>${label}</strong><div class="hint">${hint}</div></div>
            <input class="hex" data-hex="${key}" dir="ltr" maxlength="7" aria-label="${label} (رمز اللون)">
          </div>`).join('')}
        </div>

        <div>
          <h3>الخط</h3>
          <div class="field"><select id="font"></select></div>
          <div class="font-sample" id="font-sample">تقرير حالة العمل — المرحلة الثانية 2026</div>
          <div class="row wrap" style="gap:.5rem;margin-top:.6rem">
            <button class="btn subtle" id="font-up">${icon('download')}رفع ملف خط</button>
            <button class="btn ghost danger-text" id="font-del">${icon('trash')}إزالة الخط المرفوع</button>
          </div>
          <p class="hint">لاستخدام خط الشركة الخاص: ملف WOFF2 أو WOFF أو TTF أو OTF حتى 2 ميجابايت.</p>
        </div>

        <div class="form-error" role="alert"></div>
        <div class="row wrap" style="gap:.5rem">
          <button class="btn" id="save">${icon('check')}حفظ الهوية</button>
          <button class="btn ghost" id="reset">استعادة هوية ابتكار</button>
        </div>
      </section>

      <section class="stack">
        <div class="row"><h3 class="grow" style="margin:0">معاينة التقرير</h3><span class="muted small">تتحدّث مباشرة</span></div>
        <div id="preview"></div>
      </section>
    </div>`);

  const sample = sampleReport();
  const view = () => ({ ...brand, ...draft, custom: true });
  const fontSelect = $('#font', el);

  const drawFonts = () => {
    const options = [['default', DEFAULT_BRAND.font_family], ...Object.entries(WEB_FONTS)];
    if (brand.font_url || brand.font === 'custom') options.push(['custom', `خط الشركة: ${brand.font_family}`]);
    fontSelect.innerHTML = options.map(([k, label]) => `<option value="${k}" ${k === draft.font ? 'selected' : ''}>${esc(label)}</option>`).join('');
    $('#font-del', el).classList.toggle('hidden', !brand.font_url && brand.font !== 'custom');
  };
  const drawLogo = () => {
    $('#logo-box', el).innerHTML = brand.logo_url
      ? `<img src="${esc(brand.logo_url)}" alt="الشعار">` : `<span class="muted">لم يُرفع شعار بعد؛ يظهر شعار ابتكار في التقارير.</span>`;
    $('#logo-del', el).classList.toggle('hidden', !brand.logo_url);
  };
  const drawPreview = async () => {
    const b = view();
    const fontBrand = { ...b, font_url: draft.font === 'custom' ? brand.font_url || null : null };
    $('#font-sample', el).style.fontFamily = fontStack(fontBrand);
    $('#preview', el).innerHTML = reportDocHtml(sample, null, fontBrand);
    await loadBrandFont(fontBrand);
  };
  const drawColors = () => {
    for (const [key] of COLORS) {
      $(`[data-color="${key}"]`, el).value = draft[key].toLowerCase();
      $(`[data-hex="${key}"]`, el).value = draft[key];
    }
  };
  const refresh = () => { drawColors(); drawFonts(); drawLogo(); drawPreview(); };
  const adopt = (next) => {
    brand = next;
    state.me.company.brand = next;
  };
  refresh();

  $$('[data-color]', el).forEach((input) => input.addEventListener('input', () => {
    draft[input.dataset.color] = input.value.toUpperCase();
    $(`[data-hex="${input.dataset.color}"]`, el).value = draft[input.dataset.color];
    drawPreview();
  }));
  $$('[data-hex]', el).forEach((input) => input.addEventListener('input', () => {
    let v = input.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
    draft[input.dataset.hex] = v.toUpperCase();
    $(`[data-color="${input.dataset.hex}"]`, el).value = v.toLowerCase();
    drawPreview();
  }));
  fontSelect.addEventListener('change', () => { draft.font = fontSelect.value; drawPreview(); });

  const error = (msg) => { $('.form-error', el).textContent = msg; };
  $('#save', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    error('');
    adopt((await api('PATCH', '/api/company/brand', draft)).brand);
    toast('تم حفظ هوية الشركة؛ ستظهر في جميع التقارير');
    refresh();
  }));
  $('#reset', el).addEventListener('click', () => confirmDialog(
    'ستعود التقارير إلى هوية ابتكار، ويُحذف الشعار والخط المرفوع. هل تريد المتابعة؟',
    async () => {
      adopt((await api('DELETE', '/api/company/brand')).brand);
      Object.assign(draft, { primary_color: brand.primary_color, secondary_color: brand.secondary_color, accent_color: brand.accent_color, font: brand.font });
      toast('تمت استعادة هوية ابتكار');
      refresh();
    },
    'استعادة',
  ));

  $('#logo-up', el).addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const file = await pickFile('image/png,image/jpeg,image/webp,image/svg+xml');
    if (!file) return;
    await busy(button, async () => {
      adopt((await api('POST', '/api/company/brand/logo', { data: await logoDataUrl(file) })).brand);
      toast('تم رفع الشعار');
      drawLogo();
      drawPreview();
    });
  });
  $('#logo-del', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    adopt((await api('DELETE', '/api/company/brand/logo')).brand);
    drawLogo();
    drawPreview();
  }));
  $('#font-up', el).addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const file = await pickFile('.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf');
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('حجم ملف الخط أكبر من 2 ميجابايت', { error: true }); return; }
    await busy(button, async () => {
      adopt((await api('POST', '/api/company/brand/font', { data: await readFile(file), name: file.name })).brand);
      draft.font = 'custom';
      toast(`تم رفع الخط «${brand.font_family}»`);
      drawFonts();
      drawPreview();
    });
  });
  $('#font-del', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    adopt((await api('DELETE', '/api/company/brand/font')).brand);
    if (draft.font === 'custom') draft.font = brand.font;
    drawFonts();
    drawPreview();
  }));
}
