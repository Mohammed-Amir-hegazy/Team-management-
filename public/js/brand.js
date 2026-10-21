// The company's identity on its reports: colours as CSS variables, its font (a web font or an uploaded
// file) and its logo. Without one, reports keep Ebtikar's identity.

import { state, esc, mark } from './core.js';

export const DEFAULT_BRAND = {
  primary_color: '#06044B', secondary_color: '#5146E1', accent_color: '#62E98A', font: 'default',
  font_family: 'خط ابتكار (DIN Next Arabic)', font_url: null, logo_url: null, custom: false,
};

// Web fonts by key (Google Fonts), in the order offered.
export const WEB_FONTS = {
  cairo: 'Cairo', tajawal: 'Tajawal', almarai: 'Almarai', 'ibm-plex': 'IBM Plex Sans Arabic', 'noto-kufi': 'Noto Kufi Arabic',
  readex: 'Readex Pro', changa: 'Changa', 'el-messiri': 'El Messiri', amiri: 'Amiri',
};
const CUSTOM_FAMILY = 'EbtikarCompanyFont';

export function currentBrand() {
  return (state.me && state.me.company && state.me.company.brand) || DEFAULT_BRAND;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// White or dark text, whichever reads better on the colour.
export function textOn(hex) {
  return luminance(hex) > 0.42 ? '#0B0A3A' : '#FFFFFF';
}

export function fontStack(brand) {
  if (brand.font === 'custom' && brand.font_url) return `'${CUSTOM_FAMILY}', 'Ebtikar', Tahoma, sans-serif`;
  if (WEB_FONTS[brand.font]) return `'${WEB_FONTS[brand.font]}', 'Ebtikar', Tahoma, sans-serif`;
  return "'Ebtikar', 'Segoe UI', Tahoma, sans-serif";
}

// Loads the brand's font once; resolves when it is ready to use (or failed, falling back quietly).
export async function loadBrandFont(brand) {
  let family = null;
  if (WEB_FONTS[brand.font]) {
    family = WEB_FONTS[brand.font];
    const id = `font-${brand.font}`;
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;700&display=swap`;
      document.head.appendChild(link);
      await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
    }
  } else if (brand.font === 'custom' && brand.font_url) {
    family = CUSTOM_FAMILY;
    let style = document.getElementById('font-custom');
    if (!style) {
      style = document.createElement('style');
      style.id = 'font-custom';
      document.head.appendChild(style);
    }
    const css = `@font-face { font-family: '${CUSTOM_FAMILY}'; src: url('${brand.font_url}'); font-display: swap; }`;
    if (style.textContent !== css) style.textContent = css;
  }
  if (!family) return;
  try {
    await Promise.race([document.fonts.load(`16px '${family}'`, 'تقرير'), new Promise((r) => setTimeout(r, 4000))]);
  } catch { /* the fallback font is used */ }
}

// CSS variables for a report container; empty for Ebtikar's own identity so the defaults apply.
export function brandStyle(brand) {
  if (!brand.custom) return '';
  return [
    `--b-primary:${brand.primary_color}`, `--b-secondary:${brand.secondary_color}`, `--b-accent:${brand.accent_color}`,
    `--b-on-primary:${textOn(brand.primary_color)}`, `--b-on-accent:${textOn(brand.accent_color)}`, `--b-font:${fontStack(brand)}`,
  ].join(';');
}

// The logo on a report: the company's own, or Ebtikar's wordmark. "light" sits on a dark header.
export function brandLogo(brand, { onDark = true } = {}) {
  if (brand.logo_url) return `<span class="company-logo"><img src="${esc(brand.logo_url)}" alt="${esc((state.me && state.me.company && state.me.company.name) || '')}"></span>`;
  return `${mark()}<img src="/brand/wordmark-${onDark ? 'white' : 'navy'}.svg" alt="EBTIKAR">`;
}

export function brandIssuer(brand) {
  const name = state.me && state.me.company && state.me.company.name;
  return brand.custom && name ? `صادر عن ${name} — عبر منصة ابتكار لإدارة الأعمال` : 'صادر عن منصة ابتكار لإدارة الأعمال';
}

// Excel: header colours and font as the spreadsheet expects them.
export function workbookStyle(brand) {
  if (!brand.custom) return {};
  return {
    headerFill: brand.primary_color.slice(1),
    headerText: textOn(brand.primary_color).slice(1),
    font: WEB_FONTS[brand.font] || (brand.font === 'custom' ? brand.font_family : null),
  };
}
