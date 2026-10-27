// The built-in front-end. It is one client of the protocol among others:
// it reads GET /v1/state, listens on GET /v1/events, and posts answers.
import { BASE, CLOSED_LABEL, Icon, J, STATE_LABEL, VIEWER, api, h, notify, report, store, time } from './env.js';
import { Attachments, BroadcastForm, CardView, Changes, ClosedCard, HtmlCard, HtmlToggle, LinkedText, NotifyToggle, SecretForm, cardSource, describe, formValues, presenceOf } from './components.js';

const { React, createRoot } = window.__OpenUI;

export function App() {
  const [state, setState] = React.useState(null);
  const [auth, setAuth] = React.useState('checking');
  const [up, setUp] = React.useState(false);
  const [focus, setFocus] = React.useState(() => store.get('focus:current'));
  const [closing, setClosing] = React.useState({});
  const [fresh, setFresh] = React.useState({});
  const pinnedRef = React.useRef(null);
  const focusRef = React.useRef(null);
  const knownRef = React.useRef(null);
  const seenRef = React.useRef(null);
  const reportedFocus = React.useRef(undefined);
  const [groupBy, setGroupBy] = React.useState(() => store.get('groupBy') || 'none');

  const refresh = React.useCallback(() => fetch(BASE + 'v1/state').then((r) => {
    if (r.status === 401) { setAuth('needed'); return null; }
    return r.json();
  }).then((s) => {
    if (!s) return;
    setAuth('ok');
    const ids = new Set(s.cards.map((c) => c.id));
    if (knownRef.current) {
      const added = s.cards.filter((c) => !knownRef.current.has(c.id) && !c.closed);
      if (added.length) setFresh((f) => ({ ...f, ...Object.fromEntries(added.map((c) => [c.id, true])) }));
      added.forEach((c) => notify(c.kind === 'blocked' ? 'An agent is blocked' : 'An agent asked you something', c.title));
      for (const c of s.cards) {
        if (c.closed && focusRef.current === c.id && !closing[c.id] && state && !state.cards.find((x) => x.id === c.id)?.closed) setClosing((x) => ({ ...x, [c.id]: true }));
      }
    }
    knownRef.current = ids;
    setState(s);
  }), [state, closing]);
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;

  React.useEffect(() => {
    let es;
    let last = 0;
    // Sign in with the token in the address, then drop it from the address.
    const signIn = () => {
      const m = /token=([^&]+)/.exec(location.hash);
      if (!m) return Promise.resolve();
      return fetch(BASE + 'v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ token: decodeURIComponent(m[1]) }) })
        .then(() => history.replaceState(null, '', location.pathname));
    };
    const connect = () => signIn().then(() => {
      if (es) es.close();
      refreshRef.current();
      es = new EventSource(`${BASE}v1/events?viewer=${encodeURIComponent(VIEWER)}`);
      es.onopen = () => refreshRef.current();
      // A stream that fails may mean a revoked token: the state request tells.
      es.onerror = () => refreshRef.current();
      es.addEventListener('beat', () => { last = Date.now(); setUp(true); });
      es.addEventListener('change', () => refreshRef.current());
      es.addEventListener('presence', () => refreshRef.current());
      es.addEventListener('code', () => { store.set('scroll:y', window.scrollY); location.reload(); });
    });
    connect();
    window.addEventListener('hashchange', connect);
    const watchdog = setInterval(() => { if (Date.now() - last > 5000) setUp(false); }, 1000);
    return () => { if (es) es.close(); clearInterval(watchdog); window.removeEventListener('hashchange', connect); };
  }, []);

  React.useEffect(() => {
    if (!state) return;
    const y = store.get('scroll:y');
    if (y != null) { store.del('scroll:y'); requestAnimationFrame(() => window.scrollTo(0, y)); }
  }, [!!state]);

  if (auth === 'needed') {
    return h('div', { className: 'signin' }, h('h2', null, 'Sign in to your inbox'),
      h('p', null, 'Open this page with ', h('code', null, 'your-attention open'), ' on the machine that runs the inbox. Another device pairs with ', h('code', null, 'your-attention pair <url> --role owner'), '.'));
  }
  if (!state) return h('div', { className: 'done' }, 'Loading…');

  const answers = state.answers;
  const byId = Object.fromEntries(state.cards.map((c) => [c.id, c]));
  const lastReply = (c) => Math.max(0, ...c.replies.map((r) => r.at));
  // A reply newer than your answer brings the card back to your queue.
  const st = (c) => {
    const s = state.states[c.id];
    if (c.replies.some((r) => !r.seenAt) && (!answers[c.id] || lastReply(c) > answers[c.id].savedAt)) return 'reply';
    return s;
  };
  const visible = state.cards;
  const levels = state.levels || [];
  const levelOf = (c) => (state.priorities || {})[c.id] || c.priority;
  const rank = (c) => { const i = levels.findIndex((l) => l.id === levelOf(c)); return i < 0 ? levels.length : i; };
  const label = (id) => (levels.find((l) => l.id === id) || {}).label || id;
  const waiting = (s) => ['open', 'reply', 'orphaned', 'held'].includes(s);
  const pending = visible.filter((c) => waiting(st(c)))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  const checking = visible.filter((c) => st(c) === 'in-triage');
  const replied = pending.filter((c) => st(c) === 'reply').sort((a, b) => lastReply(b) - lastReply(a));
  const sentAt = (c) => (c.closed ? c.closed.at : answers[c.id] ? answers[c.id].savedAt : 0);
  const outbox = visible.filter((c) => ['answered', 'delivered'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const sent = visible.filter((c) => ['read', 'closed'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const pinned = pending.find((c) => c.id === pinnedRef.current);
  const current = byId[focus] || pinned || replied[0] || pending[0] || null;
  pinnedRef.current = current ? current.id : null;
  focusRef.current = current ? current.id : null;
  if (current && store.get('focus:current') !== current.id) store.set('focus:current', current.id);
  if (reportedFocus.current !== (current ? current.id : null)) {
    reportedFocus.current = current ? current.id : null;
    report({ focus: reportedFocus.current, active: true });
  }
  const seenKey = current ? `${current.id}:${current.replies.length}` : null;
  if (current && current.replies.some((r) => !r.seenAt) && seenRef.current !== seenKey) {
    seenRef.current = seenKey;
    setTimeout(() => api(`${BASE}v1/cards/${current.id}/seen`, {}), 1500);
  }

  const next = () => { pinnedRef.current = null; setFocus((pending.find((c) => c.id !== (current && current.id)) || {}).id || null); };
  const open = (id) => { setFocus(id); setFresh((f) => ({ ...f, [id]: false })); };

  async function onAction(c, ev) {
    if (ev.humanFriendlyMessage === 'skip' || ev.humanFriendlyMessage === 'Skip for now') return next();
    if (c.kind === 'blocked') return api(`${BASE}v1/cards/${c.id}/open`, {});
    const { values, comment } = formValues(ev.formState);
    await api(`${BASE}v1/cards/${c.id}/answer`, { values, comment, version: c.version });
    store.del(`draft:${c.id}:${c.version}`);
    setTimeout(() => { if (pinnedRef.current === c.id) pinnedRef.current = null; setFocus((f) => (f === c.id || f === null ? null : f)); }, 700);
  }

  const item = (c) => {
    const s = st(c);
    const prio = h('span', { className: `prio small ${levelOf(c)}` }, label(levelOf(c)));
    const icon = s === 'closed' ? c.closed.kind : s;
    const tip = s === 'closed' ? CLOSED_LABEL[c.closed.kind] : STATE_LABEL[s];
    return h('button', { key: c.id, className: `q ${current && current.id === c.id ? 'focus' : ''}`, onClick: () => open(c.id) },
      h('span', { className: 't' }, c.title, fresh[c.id] && h('span', { className: 'new' }, 'new'), waiting(s) && groupBy !== 'priority' && prio),
      h(Icon, { name: icon, tip, cls: `s ${s}` }));
  };
  const group = (title, items, empty, cls) => h(React.Fragment, { key: title },
    h('h3', { className: cls }, title),
    items.length ? items.map(item) : h('div', { className: 'empty' }, empty));

  // No grouping by default. The choices follow the properties the cards carry.
  const tagKeys = [...new Set(visible.flatMap((c) => Object.keys(c.tags || {})))].sort();
  const groupKey = (c) => (groupBy === 'priority' ? label(levelOf(c)) : groupBy === 'agent' ? c.agent : groupBy.startsWith('tag:') ? String((c.tags || {})[groupBy.slice(4)] || '').trim() || `No ${groupBy.slice(4)}` : 'Waiting for you');
  const rest = pending.filter((c) => st(c) !== 'reply');
  const groups = groupBy === 'none' ? [['Waiting for you', rest]] : [...rest.reduce((m, c) => m.set(groupKey(c), [...(m.get(groupKey(c)) || []), c]), new Map())];
  const queue = h('nav', { className: 'queue' },
    h('label', { className: 'group-by' }, 'Group by ',
      h('select', { value: groupBy, onChange: (e) => { setGroupBy(e.target.value); store.set('groupBy', e.target.value); } },
        h('option', { value: 'none' }, 'nothing'), h('option', { value: 'priority' }, 'priority'), h('option', { value: 'agent' }, 'agent'),
        tagKeys.map((k) => h('option', { key: k, value: `tag:${k}` }, k)))),
    replied.length > 0 && group('Agent replied', replied, ''),
    groups.length ? groups.map(([title, items]) => group(title, items, 'Nothing waiting')) : group('Waiting for you', [], 'Nothing waiting'),
    checking.length > 0 && group('Being checked by triage', checking, ''),
    group('Outbox: not read by the agent yet', outbox, 'Empty', 'sent'),
    group('Sent, newest first', sent, 'Nothing sent yet', 'sent'));

  let main;
  if (!current) {
    main = h('div', { className: 'focus-card done' }, 'Nothing needs you. New cards appear here on their own.');
  } else {
    const a = answers[current.id];
    const s = st(current);
    const pres = presenceOf(current, state);
    const prev = current.follows && byId[current.follows];
    const after = current.followedBy && byId[current.followedBy];
    const draftKey = `draft:${current.id}:${current.version}`;
    const backlinks = visible.filter((c) => c.id !== current.id && String(c.text || '').includes(`[[${current.id}]]`));
    const o = current.origin || {};
    const card = h('div', { className: 'focus-card' },
      h('div', { className: 'meta' },
        h('span', { className: `prio ${levelOf(current)}`, title: (levels.find((l) => l.id === levelOf(current)) || {}).definition }, label(levelOf(current))),
        current.status && h('span', { className: 'status' }, current.status),
        STATE_LABEL[s] && ['in-triage', 'held', 'orphaned'].includes(s) && h('span', { className: 'status warn' }, STATE_LABEL[s]),
        pres && h('span', { className: `pill small ${pres[0]}` }, pres[1])),
      current.triage && current.triage.state === 'passed' && /did not answer|failed/.test(current.triage.reason || '') && h('div', { className: 'note' }, `Triage did not check this card: ${current.triage.reason}`),
      current.triage && ['held', 'returned'].includes(current.triage.state) && h('div', { className: 'note warn' },
        `${current.triage.by || 'An extension'} ${current.triage.state === 'held' ? 'held this card' : 'sent this card back'}: ${current.triage.reason || 'no reason given'}`,
        current.triage.state === 'held' && h('button', { className: 'btn', style: { marginLeft: 8 }, onClick: () => api(`${BASE}v1/cards/${current.id}/release`, {}) }, 'Release')),
      (o.harness || o.host) && h('div', { className: 'origin' },
        h('span', null, [o.name, o.harness, o.host, o.cwd].filter(Boolean).join(' · ')),
        o.herdrPane && current.kind !== 'blocked' && h('button', { className: 'btn', onClick: () => api(`${BASE}v1/cards/${current.id}/open`, {}) }, 'Open session')),
      after && h('div', { className: 'chain' }, 'Followed by ', h('a', { onClick: () => open(after.id) }, after.title)),
      current.replies.slice().reverse().map((r) => h('div', { className: 'reply-msg', key: r.at }, h('b', null, `Agent reply · ${time(r.at)}`), r.text)),
      a && s !== 'reply' && h('div', { className: 'note ok' }, `Your answer: ${describe(current, a)}`),
      current.kind !== 'secret' && h('h2', { className: 'card-title' }, current.title),
      current.kind !== 'secret' && !current.broadcast && current.text && h(LinkedText, { text: current.text, byId, open }),
      current.attachments && h(Attachments, { files: current.attachments }),
      h(Changes, { card: current }),
      current.broadcast && !current.closed
        ? h(BroadcastForm, { card: current, onDone: next })
        : current.html !== undefined
        ? h(HtmlCard, { card: current, allowed: !!(state.settings && state.settings.allowHtml), onAnswer: (values, comment) => api(`${BASE}v1/cards/${current.id}/answer`, { values, comment, version: current.version }).then(next) })
        : current.kind === 'secret'
        ? h(React.Fragment, null,
          h('h2', { className: 'secret-title' }, current.title),
          current.text && h('p', null, current.text),
          h(SecretForm, { key: `${current.id}:${a ? a.savedAt : 0}`, card: current, onSkip: next, onSent: () => setTimeout(() => { pinnedRef.current = null; setFocus(null); }, 700) }))
        : h(CardView, { key: `${draftKey}:${a ? a.savedAt : 0}`, draftKey, response: cardSource(current), onAction: (ev) => onAction(current, ev) }),
      a && h('div', { className: 'receipt' },
        h(Icon, { name: 'answered', cls: 's answered', tip: `Stored at ${time(a.savedAt)}` }),
        h(Icon, { name: 'delivered', cls: 's delivered', dim: !a.deliveredAt, tip: a.deliveredAt ? `Delivered at ${time(a.deliveredAt)}` : 'Not delivered yet: agent offline' }),
        h(Icon, { name: 'read', cls: 's read', dim: !a.readAt, tip: a.readAt ? `Read by the agent at ${time(a.readAt)}` : 'Not read by the agent yet' }),
        !a.readAt && h('button', { className: 'btn', onClick: () => api(`${BASE}v1/cards/${current.id}/force`, {}) }, a.forcedAt ? `Force-sent at ${time(a.forcedAt)}. Send again` : 'Force-send')),
      backlinks.length > 0 && h('div', { className: 'chain' }, 'Linked from ', backlinks.map((c, i) => h(React.Fragment, { key: c.id }, i ? ', ' : '', h('a', { onClick: () => open(c.id) }, c.title)))),
      prev && h('details', { className: 'earlier' },
        h('summary', null, 'The card before this one, and your answer'),
        h('div', { className: 'turn' },
          h('h4', null, h('a', { onClick: () => open(prev.id) }, prev.title)),
          prev.text && h('p', null, prev.text),
          h('div', { className: 'ans' }, answers[prev.id] ? describe(prev, answers[prev.id]) : 'You did not answer it.'))));
    main = s === 'closed'
      ? h(ClosedCard, { key: `closed:${current.id}`, closed: current.closed, onNext: next, animate: !!closing[current.id] }, card)
      : card;
  }

  return h(React.Fragment, null,
    h('div', { className: 'bar' }, h('div', { className: 'bar-inner' },
      h('h1', null, 'Your attention'),
      state.settings && h(HtmlToggle, { settings: state.settings }),
      h(NotifyToggle),
      h('span', { className: `pill ${up ? 'on' : 'down'}` }, up ? 'Inbox connected' : 'Inbox unreachable'))),
    h('div', { className: 'layout' }, queue, h('main', null, main)));
}

// Grow each comment box to fit its text where the browser lacks CSS field-sizing.
if (!CSS.supports('field-sizing', 'content')) {
  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  document.addEventListener('input', (e) => { if (e.target.tagName === 'TEXTAREA') grow(e.target); });
}

const root = document.getElementById('app');
if (root) createRoot(root).render(h(App));
