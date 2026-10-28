// Shared by the page and its stories: addresses, storage, presence reports, labels and icons.
const { React } = window.__OpenUI;
export const h = React.createElement;
// The page may sit under a path, such as /i/<inbox id>/ on the hosted service, so every address is relative to it.
export const BASE = location.pathname.replace(/[^/]*$/, '');
export const CLOSED_LABEL = { retracted: 'Retracted by agent', 'self-answered': 'Answered by agent', 'answered-in-terminal': 'Answered in the terminal', resolved: 'No longer waiting', expired: 'Expired', returned: 'Sent back by triage' };
export const STATE_LABEL = { open: 'to answer', 'in-triage': 'being checked by triage', held: 'held by an extension', orphaned: 'its agent is gone', answered: 'stored', delivered: 'delivered', read: 'read', closed: 'closed', reply: 'new reply' };
export const J = JSON.stringify;

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
export const api = (path, body) => fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-your-attention': '1' }, body: J(body) });
export const time = (t) => new Date(t).toLocaleTimeString();

// This tab's id for presence reports. Two tabs, or two people, count as two pages.
export const VIEWER = (() => {
  try {
    const id = sessionStorage.getItem('viewer') || `v-${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
    sessionStorage.setItem('viewer', id);
    return id;
  } catch { return `v-${Math.random().toString(36).slice(2)}`; }
})();
let lastReport = 0;
export function report(fields) {
  const now = Date.now();
  if (!('visible' in fields) && !('focus' in fields) && now - lastReport < 20000) return;
  lastReport = now;
  fetch(`${BASE}v1/person/${VIEWER}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-your-attention': '1' }, body: J(fields) }).catch(() => {});
}
document.addEventListener('visibilitychange', () => report({ visible: document.visibilityState === 'visible', active: true }));
for (const ev of ['keydown', 'pointerdown', 'scroll']) window.addEventListener(ev, () => report({ active: true }), { passive: true });

// Browser notifications, only after you turn them on.
export const notifyOn = () => store.get('notify:on') === true && 'Notification' in window && Notification.permission === 'granted';
export function notify(title, body) {
  if (!notifyOn()) return;
  try { new Notification(title, { body, tag: `card:${body}` }); } catch {}
}

export const ICONS = {
  // Lucide's brush-cleaning.
  broom: ['m16 22-1-4', 'M19 13.99a1 1 0 0 0 1-1V12a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v.99a1 1 0 0 0 1 1', 'M5 14h14l1.973 6.767A1 1 0 0 1 20 22H4a1 1 0 0 1-.973-1.233z', 'm8 22 1-4'],
  // Lucide's hand: a card that waits for you raises its hand.
  open: ['M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2', 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2', 'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8', 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'],
  circle: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18'],
  reply: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  answered: ['M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7', 'M7 3v4a1 1 0 0 0 1 1h7'],
  delivered: ['M14.5 21.7a.5.5 0 0 0 .9 0l6.5-19a.5.5 0 0 0-.6-.6l-19 6.5a.5.5 0 0 0 0 .9l7.9 3.2a2 2 0 0 1 1.1 1.1z', 'm21.9 2.1-10.9 10.9'],
  read: ['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'],
  retracted: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'm15 9-6 6', 'm9 9 6 6'],
  'self-answered': ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'm9 12 2 2 4-4'],
  'answered-in-terminal': ['M4 17l6-6-6-6', 'M12 19h8'],
  resolved: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'm9 12 2 2 4-4'],
};
export const Icon = ({ name, tip, cls = '', dim = false }) => h('span', { className: `ico ${cls} ${dim ? 'dim' : ''}`, 'data-tip': tip, role: 'img', 'aria-label': tip, tabIndex: 0 },
  h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, (ICONS[name] || ICONS.circle).map((d) => h('path', { key: d, d }))));

