// Light / dark mode: the person's choice (or the device's setting) as data-theme on <html>, remembered on this device.

import { $$, icon } from './core.js';

const KEY = 'theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
export const THEME_LABELS = { auto: ['تلقائي', 'monitor'], light: ['فاتح', 'sun'], dark: ['داكن', 'moon'] };

export function themePref() {
  try {
    const v = localStorage.getItem(KEY);
    return THEME_LABELS[v] ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export const currentTheme = () => document.documentElement.dataset.theme;

function apply(animate) {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'auto' && media.matches);
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-switching');
    setTimeout(() => root.classList.remove('theme-switching'), 400);
  }
  root.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#05042E' : '#06044B');
  // Refresh every toggle on the page.
  $$('[data-theme-btn]').forEach((b) => { b.innerHTML = icon(dark ? 'sun' : 'moon'); b.setAttribute('aria-label', toggleLabel()); b.title = toggleLabel(); });
  $$('.theme-switch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === pref));
}

export function setTheme(pref) {
  try {
    if (pref === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref);
  } catch { /* private mode: applies for this visit only */ }
  apply(true);
}

const toggleLabel = () => (currentTheme() === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن');

// A one-tap button that flips between light and dark.
export function themeButton(extraClass = '') {
  const label = toggleLabel();
  return `<button type="button" class="icon-btn theme-btn ${extraClass}" data-theme-btn aria-label="${label}" title="${label}">${
    icon(currentTheme() === 'dark' ? 'sun' : 'moon')}</button>`;
}

// Three choices: follow the device, light, dark.
export function themeSwitch() {
  const pref = themePref();
  return `<div class="theme-switch" role="group" aria-label="مظهر المنصة">${Object.entries(THEME_LABELS).map(([mode, [label, ic]]) =>
    `<button type="button" data-mode="${mode}" class="${mode === pref ? 'on' : ''}">${icon(ic)}${label}</button>`).join('')}</div>`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-theme-btn]')) setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  const mode = e.target.closest('.theme-switch button');
  if (mode) setTheme(mode.dataset.mode);
});
media.addEventListener('change', () => { if (themePref() === 'auto') apply(true); });
apply(false);

// Printed reports (PDF) are always light, whatever the screen shows.
window.addEventListener('beforeprint', () => { document.documentElement.dataset.theme = 'light'; });
window.addEventListener('afterprint', () => apply(false));
