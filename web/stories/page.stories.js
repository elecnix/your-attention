// The whole page, on a stand-in inbox: fetch and EventSource answer from fixtures.
import { App } from '../app.js';
import { h } from '../env.js';
import { PNG, card } from './render.js';

export default { title: 'Page' };

function fakeInbox(state) {
  window.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('v1/state')) return Response.json(state);
    // The state sends summaries, and the page fetches the whole card it opens. The fixtures are whole cards already.
    const one = /v1\/cards\/([^/?]+)$/.exec(path);
    if (one && !(init && init.method)) {
      const c = state.cards.find((x) => x.id === decodeURIComponent(one[1]));
      return c ? Response.json({ card: c, answer: state.answers[c.id], state: state.states[c.id], rev: c.rev }) : new Response('{}', { status: 404 });
    }
    if (init && init.method) return Response.json({ ok: true });
    return Response.json({});
  };
  window.EventSource = class {
    constructor() {
      this.listeners = {};
      setTimeout(() => { this.onopen && this.onopen(); (this.listeners.beat || []).forEach((f) => f({ data: '{}' })); }, 10);
      this.timer = setInterval(() => (this.listeners.beat || []).forEach((f) => f({ data: '{}' })), 1000);
    }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    close() { clearInterval(this.timer); }
  };
}

function page(cards, extra = {}) {
  const states = Object.fromEntries(cards.map((c) => [c.id, c.state || 'open']));
  fakeInbox({ cards, answers: extra.answers || {}, presence: extra.presence || { 'claude:demo': { agent: 'claude:demo', online: true, lastSeen: Date.now() } }, states, priorities: {}, levels: [{ id: 'now', label: 'Decide now', definition: '' }, { id: 'soon', label: 'Decide soon', definition: '' }, { id: 'later', label: 'Can wait', definition: '' }], settings: { allowHtml: false }, guidance: { text: '', version: 1 } });
  try { localStorage.clear(); } catch {}
  const root = document.createElement('div');
  window.__OpenUI.createRoot(root).render(h(App));
  return root;
}

export const Queue = {
  render: () => page([
    card({ id: 'q1', title: 'Store sessions in SQLite or Postgres?', text: 'The laptop build needs one file.', recommendation: 'SQLite.', options: [{ id: 'o1', label: 'SQLite' }, { id: 'o2', label: 'Postgres' }], origin: { harness: 'claude-code', host: 'laptop', name: 'storage' } }),
    card({ id: 'q2', title: 'Which layout?', priority: 'soon', agent: 'pi:demo', attachments: [{ url: PNG, name: 'a.png', type: 'image/png', alt: 'A' }], status: 'waiting on CI' }),
    card({ id: 'q3', title: 'api-tests is waiting for you', kind: 'blocked', deliver: 'none', screen: 'Allow this command?\n❯ 1. Yes' }),
    card({ id: 'q4', title: 'Rename the retry flag?', priority: 'later' }),
  ]),
};

export const AgentOffline = {
  render: () => page([card({ id: 'off', title: 'Deploy now?', options: [{ id: 'y', label: 'Yes' }] })], { presence: { 'claude:demo': { agent: 'claude:demo', online: false, lastSeen: Date.now() - 600000 } } }),
};

export const NothingWaiting = { render: () => page([]) };
