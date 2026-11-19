// Web Push in the page: whether this browser can take it, and the steps that turn it on and off. The functions take their
// inputs as arguments and touch no globals at import, so a test can run them without a browser.

/** Whether the device is an iPhone or an iPad. iPadOS Safari reports a Mac unless the person asks for the mobile site, and a Mac has no touch screen. */
export function isIos(userAgent, touchPoints = 0) {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
}

/**
 * What this page can do about notifications: `{ ok: true, mode }` with `push` for a push that arrives with the page closed, or
 * `page` for a notification only while the page is open, or `{ ok: false, reason }` in words for the person.
 * Push needs a secure page: https, or localhost. An iPhone delivers it only to a page added to the Home Screen.
 */
export function pushSupport({ secure, ios, standalone, hasPush, hasNotification, permission }) {
  if (!secure) return { ok: false, reason: 'needs an https address' };
  if (ios && !standalone) return { ok: false, reason: 'add this page to your Home Screen first' };
  if (!hasPush && !hasNotification) return { ok: false, reason: 'this browser cannot show notifications' };
  if (permission === 'denied') return { ok: false, reason: 'the browser blocks notifications' };
  return { ok: true, mode: hasPush ? 'push' : 'page' };
}

export function b64urlToBytes(text) {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const sameBytes = (a, b) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

/**
 * Subscribe this browser and tell the inbox. `base` is the page's path, such as `/i/<id>/`, where the worker registers with
 * that scope. `collapsed` lists the groups this device collapsed. Asking for permission comes first, while the tap that
 * turned the switch on still counts as a gesture. Throws a sentence for the person.
 */
export async function enablePush({ base, collapsed, api, notification = Notification, serviceWorker = navigator.serviceWorker }) {
  const permission = notification.permission === 'granted' ? 'granted' : await notification.requestPermission();
  if (permission !== 'granted') throw new Error('the browser blocks notifications');
  const registration = await serviceWorker.register(`${base}sw.js`, { scope: base });
  await serviceWorker.ready;
  const res = await fetch(`${base}v1/push`);
  if (!res.ok) throw new Error(res.status === 423 ? 'unlock this inbox with its PIN first' : `the inbox gave no push key (${res.status})`);
  const key = b64urlToBytes((await res.json()).publicKey);
  let sub = await registration.pushManager.getSubscription();
  // A subscription made for another key, such as by an inbox that was reset, cannot be reused.
  if (sub && !sameBytes(sub.options && sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const saved = await api(`${base}v1/push`, { ...sub.toJSON(), collapsed: [...collapsed] }, 'PUT');
  if (!saved.ok) throw new Error(`the inbox did not save this device (${saved.status})`);
  return sub;
}

/** Tell the inbox this device no longer wants pushes, then drop the browser's subscription. */
export async function disablePush({ base, api, serviceWorker = navigator.serviceWorker }) {
  const registration = await serviceWorker.getRegistration(base);
  const sub = registration && (await registration.pushManager.getSubscription());
  if (!sub) return;
  await api(`${base}v1/push`, { endpoint: sub.endpoint }, 'DELETE').catch(() => {});
  await sub.unsubscribe();
}

/** Whether this browser holds a push subscription made through this inbox's worker. */
export async function hasPushSubscription({ base, serviceWorker = navigator.serviceWorker }) {
  const registration = await serviceWorker.getRegistration(base);
  return !!registration && !!(await registration.pushManager.getSubscription());
}
