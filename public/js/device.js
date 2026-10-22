// This device: the service worker (fast start, last data offline), push notifications in browsers and
// the installed web app (Web Push), and the Android app shell (Capacitor: back button, native push).

import { state, $, icon, api, toast } from './core.js';

const cap = () => window.Capacitor;
export const isNativeApp = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
// The Android build says in its user agent whether it carries Firebase (see mobile/).
const nativePushBuilt = () => /EbtikarPush/.test(navigator.userAgent);
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch { /* the app works without it, only not offline */ }
  // A tapped notification opens the page it is about.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && e.data.link) location.hash = e.data.link;
  });
}

function base64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// What this device can do: 'native' (the Android app), 'web', 'ios-install' (iPhone: add to home screen
// first), or null (not supported here).
export function pushKind() {
  const push = state.config.push || {};
  if (isNativeApp()) return push.native && nativePushBuilt() ? 'native' : null;
  if (!push.web || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIos() && !isStandalone() ? 'ios-install' : null;
  }
  return 'web';
}

export async function pushEnabled() {
  const kind = pushKind();
  if (kind === 'native') return !!state.nativeToken;
  if (kind !== 'web' || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

export async function enablePush() {
  const kind = pushKind();
  if (kind === 'native') return enableNativePush();
  if (kind !== 'web') throw new Error('الإشعارات غير مدعومة على هذا المتصفح');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('لم يُسمح بالإشعارات؛ يمكن السماح بها من إعدادات المتصفح');
  const reg = await navigator.serviceWorker.ready;
  let sub;
  try {
    sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(state.config.push.web) });
  } catch {
    throw new Error('تعذّر تفعيل الإشعارات في هذا المتصفح؛ جرّب Chrome أو Edge أو Safari بعد إضافة المنصة إلى الشاشة الرئيسية');
  }
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  return true;
}

// Signing out: this device stops receiving the person's notifications, and their saved data is cleared.
export async function forgetDevice() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      if (reg && reg.active) reg.active.postMessage({ type: 'logout' });
    }
    if (state.nativeToken) {
      await api('POST', '/api/push/unsubscribe', { token: state.nativeToken }).catch(() => {});
      state.nativeToken = null;
    }
  } catch { /* signing out goes on regardless */ }
}

// --- Android app (Capacitor) -------------------------------------------------------------------------

async function enableNativePush() {
  const { PushNotifications } = cap().Plugins;
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') throw new Error('لم يُسمح بالإشعارات؛ يمكن السماح بها من إعدادات التطبيق في الهاتف');
  await PushNotifications.createChannel({ id: 'alerts', name: 'تنبيهات ابتكار', importance: 5, sound: 'default', vibration: true }).catch(() => {});
  await PushNotifications.register();
  return true;
}

let nativeReady = false;
export async function initNativeApp() {
  if (!isNativeApp() || nativeReady) return;
  nativeReady = true;
  const { App, PushNotifications } = cap().Plugins;
  // Android back button: close an open sheet, go back, or leave the app from the home page.
  if (App) {
    App.addListener('backButton', () => {
      const sheet = document.querySelector('.modal-backdrop');
      if (sheet) { sheet.remove(); return; }
      if (location.hash && !/^#\/(dashboard)?$/.test(location.hash)) history.back();
      else App.exitApp();
    });
  }
  if (PushNotifications && pushKind() === 'native') {
    PushNotifications.addListener('registration', async ({ value }) => {
      state.nativeToken = value;
      await api('POST', '/api/push/device', { token: value, platform: 'android' }).catch(() => {});
    });
    PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const link = notification && notification.data && notification.data.link;
      if (link) location.hash = link;
    });
    // Already allowed earlier: register silently on every start so the token stays current.
    const perm = await PushNotifications.checkPermissions().catch(() => ({}));
    if (perm.receive === 'granted') await enableNativePush().catch(() => {});
  }
}

// --- A gentle, one-time invitation to turn notifications on ----------------------------------------

export async function maybePromptPush(tries = 0) {
  // Not while another sheet (e.g. "what's new") is open: try again a little later.
  if (document.querySelector('.modal-backdrop')) {
    if (tries < 20) setTimeout(() => maybePromptPush(tries + 1), 3000);
    return;
  }
  if (!state.me) return;
  const kind = pushKind();
  const key = `pushPrompt:${state.me.id}`;
  try { if (localStorage.getItem(key)) return; } catch { return; }
  if (!kind || await pushEnabled()) return;
  if (kind === 'web' && Notification.permission === 'denied') return;
  const bar = document.createElement('div');
  bar.className = 'push-prompt';
  bar.innerHTML = kind === 'ios-install'
    ? `${icon('bell')}<span class="grow">لتصلك الإشعارات على الآيفون: من Safari اضغط «مشاركة» ثم «إضافة إلى الشاشة الرئيسية»، وافتح المنصة من أيقونتها.</span>
      <button class="btn sm ghost" data-later>حسنًا</button>`
    : `${icon('bell')}<span class="grow">فعّل الإشعارات على هذا الجهاز لتصلك المهام والتذكيرات فورًا حتى لو كانت المنصة مغلقة.</span>
      <button class="btn sm" data-on>تفعيل</button><button class="btn sm ghost" data-later>لاحقًا</button>`;
  const host = $('#sub-banner');
  if (!host) return;
  host.after(bar);
  const done = () => { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } bar.remove(); };
  bar.querySelector('[data-later]').addEventListener('click', done);
  const on = bar.querySelector('[data-on]');
  if (on) {
    on.addEventListener('click', async () => {
      try {
        await enablePush();
        toast('تم تفعيل الإشعارات على هذا الجهاز');
        done();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  }
}
