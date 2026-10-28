// The built-in front-end. It is one client of the protocol among others:
// it reads GET /v1/state, listens on the page WebSocket or GET /v1/events, and posts answers.
import { BASE, CLOSED_LABEL, ICONS, Icon, J, STATE_LABEL, VIEWER, api, h, notify, report, store, time } from './env.js';
import { Attachments, BroadcastForm, agentName, CardView, Changes, ClosedCard, HtmlCard, LinkedText, NotifyToggle, openSessionLink, PhoneLink, SecretForm, answerValues, cardSource, describe, formValues, presenceOf } from './components.js';

const { React, createRoot } = window.__OpenUI;

export function App() {
  const [state, setState] = React.useState(null);
  const [auth, setAuth] = React.useState('checking');
  const [up, setUp] = React.useState(false);
  // New page code waits until the person pauses: a reload under their typing would take the field away.
  const [codeReady, setCodeReady] = React.useState(false);
  // A card in the address is one the person asked for. The card from the last visit comes back only while it waits for them.
  const [focus, setFocus] = React.useState(() => cardInAddress());
  const lastVisitRef = React.useRef(cardInAddress() ? null : store.get('focus:current'));
  const [closing, setClosing] = React.useState({});
  const [fresh, setFresh] = React.useState({});
  const pinnedRef = React.useRef(null);
  const focusRef = React.useRef(null);
  const knownRef = React.useRef(null);
  const seenRef = React.useRef(null);
  const reportedFocus = React.useRef(undefined);
  // Escape clears the card pane; nothing takes the pane again until the person picks a card.
  const [cleared, setCleared] = React.useState(false);
  const [groupBy, setGroupBy] = React.useState(() => store.get('groupBy') || 'none');
  const [queueWidth, setQueueWidth] = React.useState(() => clampWidth(Number(store.get('queueWidth')) || QUEUE_WIDTH));

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

  // New page code loads at once in a hidden tab. In a tab the person looks at, it loads once they have
  // done nothing for a moment and no field has focus. A send in flight finishes within that moment.
  // A session link anywhere on a card, in its text, its body or its Markdown files, opens that session in herdr.
  React.useEffect(() => {
    const click = (e) => {
      const a = e.target.closest && e.target.closest('a[href^="https://herdr.invalid/v1/"]');
      if (!a || e.button !== 0) return;
      e.preventDefault();
      openSessionLink(a.href, a);
    };
    document.addEventListener('click', click, true);
    return () => document.removeEventListener('click', click, true);
  }, []);

  React.useEffect(() => {
    if (!codeReady) return undefined;
    let last = Date.now();
    const busy = () => { last = Date.now(); };
    const editing = () => !!(document.activeElement && document.activeElement.closest('input, textarea, select, [contenteditable]'));
    const check = () => {
      if (document.visibilityState === 'hidden' || (Date.now() - last >= IDLE_RELOAD_MS && !editing())) reloadPage();
    };
    const events = ['keydown', 'pointerdown', 'input', 'focusin', 'focusout'];
    for (const e of events) window.addEventListener(e, busy, true);
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, 500);
    check();
    return () => {
      for (const e of events) window.removeEventListener(e, busy, true);
      document.removeEventListener('visibilitychange', check);
      clearInterval(timer);
    };
  }, [codeReady]);

  React.useEffect(() => {
    const back = () => { const id = cardInAddress(); setCleared(!id && !!(history.state && history.state.cleared)); pinnedRef.current = id; setFocus(id); };
    // Escape in a field belongs to the field, so a half-typed answer stays on screen.
    const escape = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) return;
      // The sign-in token or code stays in the address until the sign-in request has used it.
      const token = /(?:token|signin)=[^&]*/.exec(location.hash);
      if (!(history.state && history.state.cleared)) history.pushState({ cleared: true }, '', location.pathname + (token ? `#${token[0]}` : ''));
      pinnedRef.current = null;
      setFocus(null);
      setCleared(true);
    };
    window.addEventListener('popstate', back);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('popstate', back); window.removeEventListener('keydown', escape); };
  }, []);

  React.useEffect(() => {
    let es;
    let last = 0;
    // Sign in with the token in the address, then drop it from the address.
    // Sign in with the owner token, or the one-time code a phone scanned, then drop it from the address.
    const signIn = () => {
      const m = /(?:^#|&)(token|signin)=([^&]+)/.exec(location.hash);
      if (!m) return Promise.resolve();
      const body = m[1] === 'token' ? { token: decodeURIComponent(m[2]) } : { code: decodeURIComponent(m[2]) };
      return fetch(BASE + 'v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J(body) })
        .then(() => history.replaceState(history.state, '', location.pathname + location.hash.replace(/(^#|&)(token|signin)=[^&]*/, '$1').replace(/^#&?$/, '')));
    };
    let ws;
    let ping;
    let retry;
    let closed = false;
    const onEvent = (type) => {
      if (type === 'beat' || type === 'pong') { last = Date.now(); setUp(true); }
      if (type === 'change' || type === 'presence') refreshRef.current();
      if (type === 'code') setCodeReady(true);
    };
    const stop = () => {
      if (es) es.close();
      if (ws) { ws.onclose = null; ws.close(); }
      clearInterval(ping);
      clearTimeout(retry);
    };
    // The server-sent event stream, for an inbox that serves no page socket.
    const overStream = () => {
      es = new EventSource(`${BASE}v1/events?viewer=${encodeURIComponent(VIEWER)}`);
      es.onopen = () => refreshRef.current();
      // A stream that fails may mean a revoked token: the state request tells.
      es.onerror = () => refreshRef.current();
      for (const type of ['beat', 'change', 'presence', 'code']) es.addEventListener(type, () => onEvent(type));
    };
    // A WebSocket lets a cloud inbox sleep between events: its pings get their answer without waking it.
    const overSocket = () => {
      let opened = false;
      ws = new WebSocket(new URL(`${BASE}v1/ws?page=1&viewer=${encodeURIComponent(VIEWER)}`, location.href).href.replace(/^http/, 'ws'));
      ws.onopen = () => {
        opened = true;
        refreshRef.current();
        const beat = () => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); };
        beat();
        ping = setInterval(beat, 2000);
      };
      ws.onmessage = (m) => { try { onEvent(JSON.parse(m.data).type); } catch {} };
      ws.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        refreshRef.current();
        if (!opened) return overStream();
        retry = setTimeout(overSocket, 1000);
      };
    };
    const connect = () => signIn().then(() => {
      stop();
      refreshRef.current();
      overSocket();
    });
    connect();
    window.addEventListener('hashchange', connect);
    const watchdog = setInterval(() => { if (Date.now() - last > 5000) setUp(false); }, 1000);
    return () => { closed = true; stop(); clearInterval(watchdog); window.removeEventListener('hashchange', connect); };
  }, []);

  React.useEffect(() => {
    if (!state) return;
    const y = store.get('scroll:y');
    if (y != null) { store.del('scroll:y'); requestAnimationFrame(() => window.scrollTo(0, y)); }
  }, [!!state]);

  if (auth === 'needed') {
    const phone = h('p', null, 'On a phone: on a page that is signed in, tap the phone button at the top, then scan its QR code. The code works once, within 5 minutes.');
    // The page cannot sign itself in. The steps depend on where the inbox runs: on a computer, or in the cloud.
    if (LAPTOP_HOST.test(location.hostname)) {
      return h('div', { className: 'signin' }, h('h2', null, 'Sign in to your inbox'),
        h('p', null, 'This inbox runs on a computer. To sign in this browser:'),
        h('ol', null,
          h('li', null, 'Open a terminal on the computer that runs the inbox.'),
          h('li', null, 'Run ', h('code', null, 'your-attention open --link'), '. It prints a sign-in link that works once, within 5 minutes.'),
          h('li', null, 'Open that link in this browser.')),
        h('p', null, 'In your usual browser, ', h('code', null, 'your-attention open'), ' opens the page signed in, with no link to copy.'),
        phone);
    }
    return h('div', { className: 'signin' }, h('h2', null, 'Sign in to your inbox'),
      h('p', null, 'This inbox runs in the cloud. To sign in this browser, open the sign-in link you got when you created the inbox.'),
      phone);
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
  // The tab icon gets a red dot while a card waits for you.
  const icon = document.querySelector('link[rel="icon"]');
  const iconHref = pending.length ? 'favicon-waiting.svg' : 'favicon.svg';
  if (icon && icon.getAttribute('href') !== iconHref) icon.setAttribute('href', iconHref);
  const replied = pending.filter((c) => st(c) === 'reply').sort((a, b) => lastReply(b) - lastReply(a));
  const sentAt = (c) => (c.closed ? c.closed.at : answers[c.id] ? answers[c.id].savedAt : 0);
  const outbox = visible.filter((c) => ['answered', 'delivered'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const sent = visible.filter((c) => ['read', 'closed'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const pinned = pending.find((c) => c.id === pinnedRef.current);
  const lastVisit = pending.find((c) => c.id === lastVisitRef.current);
  const current = cleared ? null : byId[focus] || pinned || lastVisit || replied[0] || pending[0] || null;
  pinnedRef.current = current ? current.id : null;
  lastVisitRef.current = null;
  focusRef.current = current ? current.id : null;
  if (current && store.get('focus:current') !== current.id) store.set('focus:current', current.id);
  if (reportedFocus.current !== (current ? current.id : null)) {
    reportedFocus.current = current ? current.id : null;
    report({ focus: reportedFocus.current, active: true });
  }
  if (current && cardInAddress() !== current.id && !/(?:token|signin)=/.test(location.hash)) history.replaceState({ card: current.id }, '', cardAddress(current.id));
  const seenKey = current ? `${current.id}:${current.replies.length}` : null;
  if (current && current.replies.some((r) => !r.seenAt) && seenRef.current !== seenKey) {
    seenRef.current = seenKey;
    setTimeout(() => api(`${BASE}v1/cards/${current.id}/seen`, {}), 1500);
  }

  // Each card you open is a step in the browser's history, so back and forward move between them.
  const go = (id) => {
    if (id && id !== (current && current.id)) history.pushState({ card: id }, '', cardAddress(id));
    setCleared(false);
    setFocus(id);
    // On a phone the card sits above the queue, so the page scrolls up to the card that opened.
    if (id && window.matchMedia('(max-width: 760px)').matches) requestAnimationFrame(() => document.querySelector('.focus-card')?.scrollIntoView({ block: 'start' }));
  };
  // Skip opens the card after this one, in the order the queue shows, and wraps around at the end.
  const next = () => {
    pinnedRef.current = null;
    const i = order.findIndex((c) => c.id === (current && current.id));
    const after = i < 0 ? order : [...order.slice(i + 1), ...order.slice(0, i)];
    go((after[0] || {}).id || null);
  };
  const open = (id) => { go(id); setFresh((f) => ({ ...f, [id]: false })); };

  async function onAction(c, ev) {
    if (ev.humanFriendlyMessage === 'skip' || ev.humanFriendlyMessage === 'Skip for now') return next();
    if (c.kind === 'blocked' && ev.humanFriendlyMessage !== 'send answer') return api(`${BASE}v1/cards/${c.id}/open`, {});
    const { values: picked, comment } = formValues(ev.formState);
    const values = answerValues(c, picked);
    await api(`${BASE}v1/cards/${c.id}/answer`, { values, comment, version: c.version });
    store.del(`draft:${c.id}:${c.version}`);
    setTimeout(() => { if (pinnedRef.current === c.id) pinnedRef.current = null; setFocus((f) => (f === c.id || f === null ? null : f)); }, 700);
  }

  const item = (c, dim) => {
    const s = st(c);
    const prio = h('span', { className: `prio small ${levelOf(c)}` }, label(levelOf(c)));
    // Every card that waits for you raises its hand, except an agent reply, which keeps its speech bubble.
    const icon = s === 'closed' ? c.closed.kind : waiting(s) && s !== 'reply' ? 'open' : s;
    const tip = s === 'closed' ? CLOSED_LABEL[c.closed.kind] : STATE_LABEL[s];
    return h('button', { key: c.id, className: `q${current && current.id === c.id ? ' focus' : ''}${dim ? ' dim' : ''}`, onClick: () => open(c.id) },
      h('span', { className: 't' }, c.title, fresh[c.id] && h('span', { className: 'new' }, 'new'), waiting(s) && groupBy !== 'priority' && prio),
      h(Icon, { name: icon, tip, cls: `s ${s}` }));
  };
  const group = (title, items, empty, cls, action) => h(React.Fragment, { key: title },
    h('h3', { className: cls }, title, action),
    // The cards you sent are done with: they read dimmer than the ones that wait for you.
    items.length ? items.map((c) => item(c, cls === 'sent')) : h('div', { className: 'empty' }, empty));

  // No grouping by default. The choices follow the properties the cards carry.
  const tagKeys = [...new Set(visible.flatMap((c) => Object.keys(c.tags || {})))].sort();
  const groupKey = (c) => (groupBy === 'priority' ? label(levelOf(c)) : groupBy === 'agent' ? agentName(c.agent, visible) : groupBy.startsWith('tag:') ? String((c.tags || {})[groupBy.slice(4)] || '').trim() || `No ${groupBy.slice(4)}` : 'Waiting for you');
  const rest = pending.filter((c) => st(c) !== 'reply');
  // The cards the inbox clears: answered or closed, with no agent reply you have not seen. Search still finds them.
  const dealt = visible.filter((c) => ['closed', 'answered', 'delivered', 'read'].includes(st(c)));
  const groups = groupBy === 'none' ? [['Waiting for you', rest]] : [...rest.reduce((m, c) => m.set(groupKey(c), [...(m.get(groupKey(c)) || []), c]), new Map())];
  const order = [...replied, ...groups.flatMap(([, items]) => items)];
  const queue = h('nav', { className: 'queue' },
    h('label', { className: 'group-by' }, 'Group by ',
      h('select', { value: groupBy, onChange: (e) => { setGroupBy(e.target.value); store.set('groupBy', e.target.value); } },
        h('option', { value: 'none' }, 'nothing'), h('option', { value: 'priority' }, 'priority'), h('option', { value: 'agent' }, 'agent'),
        tagKeys.map((k) => h('option', { key: k, value: `tag:${k}` }, k)))),
    replied.length > 0 && group('Agent replied', replied, ''),
    groups.length ? groups.map(([title, items]) => group(title, items, 'Nothing waiting')) : group('Waiting for you', [], 'Nothing waiting'),
    checking.length > 0 && group('Being checked by triage', checking, ''),
    group('Outbox: not read by the agent yet', outbox, 'Empty', 'sent'),
    group('Sent, newest first', sent, 'Nothing sent yet', 'sent', dealt.length > 0 && h(ClearButton, { count: dealt.length })),
    dealt.length > 0 && h('button', { className: 'btn clear-dealt', onClick: () => api(`${BASE}v1/archive`, {}) },
      `Clear ${dealt.length} answered or closed card${dealt.length === 1 ? '' : 's'}`));

  let main;
  if (!current) {
    main = h('div', { className: 'focus-card done' }, cleared && pending.length ? 'No card selected. Pick a card from the list.' : 'Nothing needs you. New cards appear here on their own.');
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
      current.from && h('div', { className: 'from' }, `From ${current.from}`),
      (o.harness || o.host || o.herdrWorkspace || o.herdrTab) && h('div', { className: 'origin' },
        h('span', null, [o.name, o.harness, o.host, o.cwd].filter(Boolean).join(' · ')),
        (o.herdrWorkspace || o.herdrTab) && h('span', { className: 'herdr-place' },
          `herdr: ${[o.herdrWorkspace && `workspace ${o.herdrWorkspace}`, o.herdrTab && `tab ${o.herdrTab}`].filter(Boolean).join(' › ')}`),
        o.herdrPane && current.kind !== 'blocked' && h('button', { className: 'btn', onClick: () => api(`${BASE}v1/cards/${current.id}/open`, {}) }, 'Open session')),
      after && h('div', { className: 'chain' }, 'Followed by ', h('a', { onClick: () => open(after.id) }, after.title)),
      current.replies.slice().reverse().map((r) => h('div', { className: 'reply-msg', key: r.at }, h('b', null, `Agent reply · ${time(r.at)}`), r.text)),
      a && s !== 'reply' && h('div', { className: 'note ok' }, `Your answer: ${describe(current, a)}`),
      current.kind !== 'secret' && h('h2', { className: 'card-title' }, current.title),
      current.kind !== 'secret' && !current.broadcast && current.text && h(LinkedText, { text: current.text, byId, open }),
      current.attachments && h(Attachments, { files: current.attachments }),
      h(Changes, { card: current }),
      current.broadcast && !current.closed
        ? h(BroadcastForm, { card: current, cards: state.cards, onDone: next })
        : current.html !== undefined
        ? h(HtmlCard, { key: current.id, card: current, onSkip: next, allowed: !!(state.settings && state.settings.allowHtml), onAnswer: (values, comment) => api(`${BASE}v1/cards/${current.id}/answer`, { values, comment, version: current.version }).then(next) })
        : current.kind === 'secret'
        ? h(React.Fragment, null,
          h('h2', { className: 'secret-title' }, current.title),
          current.text && h('p', null, current.text),
          h(SecretForm, { key: `${current.id}:${a ? a.savedAt : 0}`, card: current, onSkip: next, onSent: () => setTimeout(() => { pinnedRef.current = null; setFocus(null); }, 700) }))
        : h(CardView, { key: `${current.id}:${a ? a.savedAt : 0}`, draftKey, response: cardSource(current), onAction: (ev) => onAction(current, ev) }),
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
      h(NotifyToggle),
      h('span', { className: `pill status-pill ${up ? 'on' : 'down'}`, title: up ? 'Inbox connected' : 'Inbox unreachable' }, h('span', { className: 'pill-text' }, up ? 'Inbox connected' : 'Inbox unreachable')),
      h(PhoneLink),
      h('a', { className: 'repo', href: 'https://github.com/elecnix/your-attention', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Your Attention on GitHub', title: 'Your Attention on GitHub' },
        h('svg', { viewBox: '0 0 16 16', width: 22, height: 22, 'aria-hidden': 'true', fill: 'currentColor' }, h('path', { d: OCTOCAT }))))),
    h('div', { className: 'layout', style: { '--queue-w': `${queueWidth}px` } },
      queue, h(QueueResizer, { width: queueWidth, onResize: setQueueWidth }), h('main', null,
        // On a phone the queue sits below the card, so a button above the card says how many wait and jumps there.
        main && pending.length > 0 && h('button', { type: 'button', className: 'btn to-queue', onClick: () => document.querySelector('.queue')?.scrollIntoView({ behavior: 'smooth' }) }, `${pending.length} waiting · show the queue`),
        main)));
}

const IDLE_RELOAD_MS = 3000;
// An inbox at a loopback, private network or .local address runs on a computer, where `your-attention open` signs in.
const LAPTOP_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\[f[cd][0-9a-f:]*\]|\[fe80:[0-9a-f:]*\]|[\w-]+\.local)$/i;

// Reload for new page code, back at the same scroll position. Drafts live in storage, so typed text comes back.
function reloadPage() {
  store.set('scroll:y', window.scrollY);
  location.reload();
}

// A broom beside the Sent header, so clearing the cards you dealt with needs no scroll to the bottom of the list.
function ClearButton({ count }) {
  const tip = `Clear ${count} answered or closed card${count === 1 ? '' : 's'}`;
  return h('button', { type: 'button', className: 'icon-btn clear-sent', title: tip, 'aria-label': tip, onClick: () => api(`${BASE}v1/archive`, {}) },
    h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ICONS.broom.map((d) => h('path', { key: d, d }))));
}

// GitHub's mark, from Octicons (mark-github).
const OCTOCAT = 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

// The card on screen is in the address as #card=<id>, beside the sign-in token while it is there.
const cardInAddress = () => {
  const m = /(?:^#|&)card=([^&]+)/.exec(location.hash);
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
};
const cardAddress = (id) => `${location.pathname}#card=${encodeURIComponent(id)}`;

const QUEUE_WIDTH = 290;
const clampWidth = (w) => Math.round(Math.min(Math.max(w, 200), Math.max(200, window.innerWidth - 360)));

// The border between the queue and the card. Drag it, or focus it and press the arrow keys,
// to change the queue's width. A double click restores the default. The page keeps the width.
function QueueResizer({ width, onResize }) {
  const [dragging, setDragging] = React.useState(false);
  const set = (w) => { const v = clampWidth(w); onResize(v); store.set('queueWidth', v); };
  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = e.clientX - width;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (m) => onResize(clampWidth(m.clientX - start));
    const up = (u) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragging(false);
      set(u.clientX - start);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const key = (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') set(width - step);
    else if (e.key === 'ArrowRight') set(width + step);
    else return;
    e.preventDefault();
  };
  return h('div', {
    className: `resizer${dragging ? ' dragging' : ''}`, role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical',
    'aria-label': 'Resize the card list', 'aria-valuenow': width, 'aria-valuemin': 200, title: 'Drag to resize the card list',
    onPointerDown: down, onKeyDown: key, onDoubleClick: () => set(QUEUE_WIDTH),
  });
}

// Grow each comment box to fit its text where the browser lacks CSS field-sizing.
if (!CSS.supports('field-sizing', 'content')) {
  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  document.addEventListener('input', (e) => { if (e.target.tagName === 'TEXTAREA') grow(e.target); });
}

const root = document.getElementById('app');
if (root) createRoot(root).render(h(App));
