// The built-in front-end. It is one client of the protocol among others:
// it reads GET /v1/state, listens on GET /v1/events, and posts answers.
const { React, createRoot, Renderer, openuiChatLibrary } = window.__OpenUI;
const h = React.createElement;
const PRIO = { now: 'Decide now', soon: 'Decide soon', later: 'Can wait' };
const RANK = { now: 0, soon: 1, later: 2 };
const CLOSED_LABEL = { retracted: 'Retracted by agent', 'self-answered': 'Answered by agent', 'answered-in-terminal': 'Answered in the terminal', resolved: 'No longer waiting' };
const STATE_LABEL = { open: 'to answer', answered: 'stored', delivered: 'delivered', read: 'read', closed: 'closed', reply: 'new reply' };
const J = JSON.stringify;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const api = (path, body) => fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-your-attention': '1' }, body: J(body) });
const time = (t) => new Date(t).toLocaleTimeString();

// Browser notifications, only after you turn them on.
const notifyOn = () => store.get('notify:on') === true && 'Notification' in window && Notification.permission === 'granted';
function notify(title, body) {
  if (!notifyOn()) return;
  try { new Notification(title, { body, tag: `card:${body}` }); } catch {}
}

const ICONS = {
  open: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18'],
  reply: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  answered: ['M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7', 'M7 3v4a1 1 0 0 0 1 1h7'],
  delivered: ['M14.5 21.7a.5.5 0 0 0 .9 0l6.5-19a.5.5 0 0 0-.6-.6l-19 6.5a.5.5 0 0 0 0 .9l7.9 3.2a2 2 0 0 1 1.1 1.1z', 'm21.9 2.1-10.9 10.9'],
  read: ['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'],
  retracted: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'm15 9-6 6', 'm9 9 6 6'],
  'self-answered': ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'm9 12 2 2 4-4'],
  'answered-in-terminal': ['M4 17l6-6-6-6', 'M12 19h8'],
  resolved: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'm9 12 2 2 4-4'],
};
const Icon = ({ name, tip, cls = '', dim = false }) => h('span', { className: `ico ${cls} ${dim ? 'dim' : ''}`, 'data-tip': tip, role: 'img', 'aria-label': tip, tabIndex: 0 },
  h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, (ICONS[name] || ICONS.open).map((d) => h('path', { key: d, d }))));

// OpenUI Lang for a card that brings no body of its own.
function cardSource(c) {
  if (c.body) return c.body;
  // The origin line above the card shows where it came from, so the header has no subtitle.
  const subtitle = '';
  if (c.kind === 'blocked') {
    return [
      'root = Card([header, screen, buttons])',
      `header = CardHeader(${J(c.title)}, ${J(subtitle)})`,
      `screen = CodeBlock("text", ${J(c.screen || '(screen unavailable)')})`,
      'buttons = Buttons([go, skip], "row")',
      'go = Button("Open session", @ToAssistant("open session"), "primary")',
      'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
    ].join('\n');
  }
  const parts = ['header'];
  const L = [`header = CardHeader(${J(c.title)}, ${J(subtitle)})`];
  if (c.text) { parts.push('text'); L.push(`text = TextContent(${J(c.text)})`); }
  if (c.recommendation) { parts.push('rec'); L.push(`rec = TextContent(${J(`Recommendation: ${c.recommendation}`)})`); }
  const controls = [];
  (c.questions || []).forEach((q, i) => {
    controls.push(`fc${i}`);
    const opts = (q.options || []).map((o, j) => [`o${i}_${j}`, o]);
    L.push(`fc${i} = FormControl(${J(q.question)}, q${i})`);
    L.push(`q${i} = OptionCards("q${i}", ${J(q.multiSelect ? 'multiple' : 'single')}, [${opts.map(([r]) => r).join(', ')}])`);
    opts.forEach(([r, o]) => L.push(`${r} = OptionCard(${J(o.label)}, ${J(o.label)}, ${J(o.description || '')})`));
  });
  if (c.options && c.options.length) {
    controls.push('fcChoice');
    L.push('fcChoice = FormControl("Your answer", choice)');
    L.push(`choice = OptionCards("choice", ${J(c.multiple ? 'multiple' : 'single')}, [${c.options.map((_, j) => `c${j}`).join(', ')}])`);
    c.options.forEach((o, j) => L.push(`c${j} = OptionCard(${J(o.id)}, ${J(o.label)}, ${J(o.description || '')})`));
  }
  controls.push('fcComment');
  L.push('fcComment = FormControl("Comment", comment)', 'comment = TextArea("comment", "Anything to add?", 3)');
  parts.push('form');
  L.push(`form = Form(${J(c.id)}, buttons, [${controls.join(', ')}])`,
    'buttons = Buttons([save, skip], "row")',
    'save = Button("Send answer", @ToAssistant("send answer"), "primary")',
    'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")');
  return [`root = Card([${parts.join(', ')}])`, ...L].join('\n');
}

// Form values by field name, without the comment.
function formValues(formState) {
  const values = {};
  let comment = '';
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && 'value' in v) {
        if (k === 'comment') comment = String(v.value || '').trim();
        else values[k] = v.value;
      } else walk(v);
    }
  };
  walk(formState);
  return { values, comment };
}

function describe(card, a) {
  if (!a) return '';
  if (card.kind === 'secret') return [a.values && a.values.sealed ? 'Sent sealed' : 'Declined', a.comment].filter(Boolean).join('\n');
  const picks = Object.entries(a.values || {}).map(([k, v]) => {
    const list = [].concat(v);
    if (k === 'choice' && card.options) return list.map((x) => (card.options.find((o) => o.id === x) || {}).label || x).join(', ');
    const qi = /^q(\d+)$/.exec(k);
    if (qi && card.questions) return `${card.questions[Number(qi[1])]?.question || k} ${list.join(', ')}`;
    return `${k}: ${list.join(', ')}`;
  });
  return [...picks, a.comment].filter(Boolean).join('\n') || 'Empty answer';
}

// One rendered card. Its initial state is read once, so later renders keep what you typed.
function CardView({ draftKey, response, onAction }) {
  const [initialState] = React.useState(() => store.get(draftKey) || undefined);
  const actionRef = React.useRef(onAction);
  actionRef.current = onAction;
  const handlers = React.useMemo(() => ({
    onStateUpdate: (s) => store.set(draftKey, s),
    onAction: (ev) => actionRef.current(ev),
  }), [draftKey]);
  return h(Renderer, { response, library: openuiChatLibrary, initialState, ...handlers });
}

// A card the agent closed while you looked at it: it collapses to its outcome, and opens again on demand.
function ClosedCard({ closed, children, onNext, animate }) {
  const ref = React.useRef(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const [height, setHeight] = React.useState(null);
  React.useLayoutEffect(() => {
    setHeight(ref.current.scrollHeight);
    if (!animate) { setCollapsed(true); return undefined; }
    const t = setTimeout(() => setCollapsed(true), 900);
    return () => clearTimeout(t);
  }, []);
  return h('div', null,
    h('div', { className: 'closed-line', style: { marginBottom: collapsed ? 0 : 10 } },
      h('span', { className: 'tag' }, CLOSED_LABEL[closed.kind] || 'Closed'),
      h('span', { className: 'o' }, closed.outcome),
      h('button', { className: 'btn', onClick: () => setCollapsed((c) => !c) }, collapsed ? 'Reply' : 'Hide card'),
      h('button', { className: 'btn', onClick: onNext }, 'Next card')),
    h('div', { ref, className: 'collapse', style: { maxHeight: collapsed ? 0 : (height || 4000), opacity: collapsed ? 0 : 1 } }, children));
}

// A secret request. The value is sealed in this browser with the agent's key,
// so the inbox stores only ciphertext. Drafts are never saved for it.
function SecretForm({ card, onSent, onSkip }) {
  const [value, setValue] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState(null);
  if (!window.isSecureContext || !crypto.subtle) {
    return h('div', { className: 'note warn' }, 'This page cannot seal a secret over plain HTTP from another machine. Open the inbox on the machine that runs it, or over HTTPS.');
  }
  async function send(withValue) {
    setError(null);
    try {
      const values = {};
      if (withValue) {
        const { seal } = await import('/sealed.js');
        values.sealed = await seal(card.secret.publicKey, value);
      }
      const res = await api(`/v1/cards/${card.id}/answer`, { values, comment: comment.trim(), version: card.version });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
      setValue('');
      onSent();
    } catch (e) {
      setError(String(e.message || e));
    }
  }
  return h('form', { className: 'secret', onSubmit: (e) => { e.preventDefault(); send(true); } },
    h('label', null, card.secret.name,
      h('input', { type: 'password', autoComplete: 'off', spellCheck: false, value, onChange: (e) => setValue(e.target.value) })),
    h('label', null, 'Comment', h('textarea', { rows: 2, value: comment, onChange: (e) => setComment(e.target.value), placeholder: 'Anything to add?' })),
    error && h('div', { className: 'note warn' }, error),
    h('div', { className: 'nav' },
      h('button', { className: 'btn primary', type: 'submit', disabled: !value }, 'Send sealed'),
      h('button', { className: 'btn', type: 'button', onClick: () => send(false) }, 'Decline'),
      h('button', { className: 'btn', type: 'button', onClick: onSkip }, 'Skip for now')),
    h('p', { className: 'hint' }, 'Your browser encrypts the value for this session only. The inbox stores the ciphertext, and the model sees a file path, never the value.'));
}

function NotifyToggle() {
  const [on, setOn] = React.useState(notifyOn());
  if (!('Notification' in window)) return null;
  async function toggle() {
    if (on) { store.set('notify:on', false); return setOn(false); }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    store.set('notify:on', perm === 'granted');
    setOn(perm === 'granted');
  }
  const blocked = Notification.permission === 'denied';
  return h('label', { className: 'notify', title: blocked ? 'The browser blocks notifications for this page' : 'Show a browser notification for new cards' },
    h('input', { type: 'checkbox', role: 'switch', checked: on, disabled: blocked, onChange: toggle }), 'Notify me');
}

function presenceOf(card, state) {
  if (card.deliver === 'none') return null;
  const p = state.presence[card.agent];
  if (!p || !p.online) return ['off', 'Agent offline: your answer waits until its session resumes'];
  const unread = state.cards.some((c) => c.agent === card.agent && state.states[c.id] === 'delivered');
  return unread ? ['busy', 'Agent busy: it has an answer it has not read yet'] : ['on', 'Agent listening'];
}

function App() {
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

  const refresh = React.useCallback(() => fetch('/v1/state').then((r) => {
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
      return fetch('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ token: decodeURIComponent(m[1]) }) })
        .then(() => history.replaceState(null, '', location.pathname));
    };
    const connect = () => signIn().then(() => {
      if (es) es.close();
      refreshRef.current();
      es = new EventSource('/v1/events');
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
  const pending = visible.filter((c) => st(c) === 'open' || st(c) === 'reply')
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt);
  const replied = pending.filter((c) => st(c) === 'reply').sort((a, b) => lastReply(b) - lastReply(a));
  const sentAt = (c) => (c.closed ? c.closed.at : answers[c.id] ? answers[c.id].savedAt : 0);
  const outbox = visible.filter((c) => ['answered', 'delivered'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const sent = visible.filter((c) => ['read', 'closed'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const pinned = pending.find((c) => c.id === pinnedRef.current);
  const current = byId[focus] || pinned || replied[0] || pending[0] || null;
  pinnedRef.current = current ? current.id : null;
  focusRef.current = current ? current.id : null;
  if (current && store.get('focus:current') !== current.id) store.set('focus:current', current.id);
  const seenKey = current ? `${current.id}:${current.replies.length}` : null;
  if (current && current.replies.some((r) => !r.seenAt) && seenRef.current !== seenKey) {
    seenRef.current = seenKey;
    setTimeout(() => api(`/v1/cards/${current.id}/seen`, {}), 1500);
  }

  const next = () => { pinnedRef.current = null; setFocus((pending.find((c) => c.id !== (current && current.id)) || {}).id || null); };
  const open = (id) => { setFocus(id); setFresh((f) => ({ ...f, [id]: false })); };

  async function onAction(c, ev) {
    if (ev.humanFriendlyMessage === 'skip' || ev.humanFriendlyMessage === 'Skip for now') return next();
    if (c.kind === 'blocked') return api(`/v1/cards/${c.id}/open`, {});
    const { values, comment } = formValues(ev.formState);
    await api(`/v1/cards/${c.id}/answer`, { values, comment, version: c.version });
    store.del(`draft:${c.id}:${c.version}`);
    setTimeout(() => { if (pinnedRef.current === c.id) pinnedRef.current = null; setFocus((f) => (f === c.id || f === null ? null : f)); }, 700);
  }

  const item = (c) => {
    const s = st(c);
    const icon = s === 'closed' ? c.closed.kind : s;
    const tip = s === 'closed' ? CLOSED_LABEL[c.closed.kind] : STATE_LABEL[s];
    return h('button', { key: c.id, className: `q ${current && current.id === c.id ? 'focus' : ''}`, onClick: () => open(c.id) },
      h('span', { className: 't' }, c.title, fresh[c.id] && h('span', { className: 'new' }, 'new')),
      h(Icon, { name: icon, tip, cls: `s ${s}` }));
  };
  const group = (title, items, empty, cls) => h(React.Fragment, { key: title },
    h('h3', { className: cls }, title),
    items.length ? items.map(item) : h('div', { className: 'empty' }, empty));

  const queue = h('nav', { className: 'queue' },
    replied.length > 0 && group('Agent replied', replied, ''),
    ['now', 'soon', 'later'].map((p) => group(PRIO[p], pending.filter((c) => c.priority === p && st(c) !== 'reply'), 'Nothing waiting')),
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
    const o = current.origin || {};
    const card = h('div', { className: 'focus-card' },
      h('div', { className: 'meta' },
        h('span', { className: `prio ${current.priority}` }, PRIO[current.priority]),
        pres && h('span', { className: `pill small ${pres[0]}` }, pres[1])),
      (o.harness || o.host) && h('div', { className: 'origin' },
        h('span', null, [o.name, o.harness, o.host, o.cwd].filter(Boolean).join(' · ')),
        o.herdrPane && current.kind !== 'blocked' && h('button', { className: 'btn', onClick: () => api(`/v1/cards/${current.id}/open`, {}) }, 'Open session')),
      after && h('div', { className: 'chain' }, 'Followed by ', h('a', { onClick: () => open(after.id) }, after.title)),
      current.replies.slice().reverse().map((r) => h('div', { className: 'reply-msg', key: r.at }, h('b', null, `Agent reply · ${time(r.at)}`), r.text)),
      a && s !== 'reply' && h('div', { className: 'note ok' }, `Your answer: ${describe(current, a)}`),
      current.kind === 'secret'
        ? h(React.Fragment, null,
          h('h2', { className: 'secret-title' }, current.title),
          current.text && h('p', null, current.text),
          h(SecretForm, { key: `${current.id}:${a ? a.savedAt : 0}`, card: current, onSkip: next, onSent: () => setTimeout(() => { pinnedRef.current = null; setFocus(null); }, 700) }))
        : h(CardView, { key: `${draftKey}:${a ? a.savedAt : 0}`, draftKey, response: cardSource(current), onAction: (ev) => onAction(current, ev) }),
      a && h('div', { className: 'receipt' },
        h(Icon, { name: 'answered', cls: 's answered', tip: `Stored at ${time(a.savedAt)}` }),
        h(Icon, { name: 'delivered', cls: 's delivered', dim: !a.deliveredAt, tip: a.deliveredAt ? `Delivered at ${time(a.deliveredAt)}` : 'Not delivered yet: agent offline' }),
        h(Icon, { name: 'read', cls: 's read', dim: !a.readAt, tip: a.readAt ? `Read by the agent at ${time(a.readAt)}` : 'Not read by the agent yet' }),
        !a.readAt && h('button', { className: 'btn', onClick: () => api(`/v1/cards/${current.id}/force`, {}) }, a.forcedAt ? `Force-sent at ${time(a.forcedAt)}. Send again` : 'Force-send')),
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
      h(NotifyToggle),
      h('span', { className: `pill ${up ? 'on' : 'down'}` }, up ? 'Inbox connected' : 'Inbox unreachable'))),
    h('div', { className: 'layout' }, queue, h('main', null, main)));
}

// Grow each comment box to fit its text where the browser lacks CSS field-sizing.
if (!CSS.supports('field-sizing', 'content')) {
  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  document.addEventListener('input', (e) => { if (e.target.tagName === 'TEXTAREA') grow(e.target); });
}

createRoot(document.getElementById('app')).render(h(App));
