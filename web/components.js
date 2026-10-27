// The parts of the page, each one renderable alone, as the stories do.
import { BASE, CLOSED_LABEL, Icon, J, api, h, notifyOn, store } from './env.js';
import { renderMarkdown } from './markdown.js';

const { React, Renderer, openuiChatLibrary } = window.__OpenUI;

// OpenUI Lang for a card that brings no body of its own.
export function cardSource(c) {
  if (c.body) return c.body;
  if (c.kind === 'blocked') {
    return [
      'root = Card([screen, buttons])',
      `screen = CodeBlock("text", ${J(c.screen || '(screen unavailable)')})`,
      'buttons = Buttons([go, skip], "row")',
      'go = Button("Open session", @ToAssistant("open session"), "primary")',
      'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
    ].join('\n');
  }
  // The page shows the title above the text and attachments, so a generated card has no header.
  const parts = [];
  const L = [];
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
export function formValues(formState) {
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

export function describe(card, a) {
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
export function CardView({ draftKey, response, onAction }) {
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
export function ClosedCard({ closed, children, onNext, animate }) {
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
export function SecretForm({ card, onSent, onSkip }) {
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
        const { seal } = await import(`${BASE}sealed.js`);
        values.sealed = await seal(card.secret.publicKey, value);
      }
      const res = await api(`${BASE}v1/cards/${card.id}/answer`, { values, comment: comment.trim(), version: card.version });
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

// Card text with [[card-id]] links. A link shows the linked card title, and its text on hover.
export function LinkedText({ text, byId, open }) {
  const parts = String(text).split(/(\[\[[\w.:-]+\]\])/);
  return h('div', { className: 'card-text' }, parts.map((p, i) => {
    const m = /^\[\[([\w.:-]+)\]\]$/.exec(p);
    if (!m) return h(React.Fragment, { key: i }, p);
    const target = byId[m[1]];
    if (!target) return h('span', { key: i, className: 'dead-link', title: 'This card is not in the inbox' }, m[1]);
    const preview = [target.title, target.text].filter(Boolean).join('\n\n').slice(0, 400);
    return h('a', { key: i, className: 'card-link', title: preview, onClick: () => open(target.id) }, target.title);
  }));
}

export const isImage = (t) => /^image\/(png|jpeg|gif|webp)$/.test(t);
export const fileUrl = (f) => f.url || `${BASE}v1/attachments/${encodeURIComponent(f.id)}`;
export const sizeText = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// One attached file, rendered by its type: Markdown, CSV and JSON in place, PDF in a frame, anything else as a download.
export function FileView({ file }) {
  const [text, setText] = React.useState(null);
  const textual = /^(text\/(markdown|plain|csv)|application\/json)$/.test(file.type);
  React.useEffect(() => {
    if (!textual) return;
    fetch(fileUrl(file)).then((r) => r.text()).then(setText, () => setText(''));
  }, [file.id, file.url]);
  const download = h('a', { className: 'file-name', href: file.id ? `${fileUrl(file)}?download=1` : file.url, download: file.name, target: '_blank', rel: 'noopener' }, file.name);
  let body = null;
  // Only the inbox's own copy of a PDF goes in a frame. Its response blocks scripts. A PDF elsewhere stays a link.
  if (file.type === 'application/pdf' && file.id) body = h('iframe', { className: 'pdf', src: fileUrl(file), title: file.name, sandbox: 'allow-downloads' });
  else if (textual && text != null) {
    if (file.type === 'text/markdown') body = h('div', { className: 'markdown' }, renderMarkdown(h, text));
    else if (file.type === 'text/csv') {
      const rows = text.trim().split(/\r?\n/).map((l) => l.split(','));
      body = h('table', { className: 'csv' }, h('tbody', null, rows.slice(0, 200).map((r, i) => h('tr', { key: i }, r.map((c, j) => h(i ? 'td' : 'th', { key: j }, c))))));
    } else if (file.type === 'application/json') {
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      body = h('pre', null, pretty);
    } else body = h('pre', null, text);
  }
  return h('div', { className: 'file' }, h('div', { className: 'file-head' }, download, h('span', { className: 'file-size' }, [file.type, sizeText(file.size)].filter(Boolean).join(' · '))), body);
}

export function Attachments({ files }) {
  const images = files.filter((f) => isImage(f.type));
  const others = files.filter((f) => !isImage(f.type));
  return h('div', { className: 'attachments' },
    images.length > 0 && h('div', { className: 'gallery' }, images.map((f, i) => h('a', { key: i, href: fileUrl(f), target: '_blank', rel: 'noopener', title: f.alt || f.name },
      h('img', { src: fileUrl(f), alt: f.alt || f.name, loading: 'lazy' })))),
    others.map((f, i) => h(FileView, { key: f.id || f.url || i, file: f })));
}

// A card that brings its own HTML runs in a frame with scripts but no access to the inbox.
// The frame answers by posting a message: yourAttention.answer(values, comment).
export const FRAME_BRIDGE = '<script>window.yourAttention={answer:function(v,c){parent.postMessage({yourAttention:"answer",values:v||{},comment:c||""},"*")}};<\/script>';
export function HtmlCard({ card, allowed, onAnswer }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const listen = (e) => {
      if (!ref.current || e.source !== ref.current.contentWindow || !e.data || e.data.yourAttention !== 'answer') return;
      onAnswer(typeof e.data.values === 'object' && e.data.values ? e.data.values : {}, String(e.data.comment || ''));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [card.id, card.version]);
  if (!allowed) return h('div', { className: 'note warn' }, 'This card brings its own HTML and scripts. Turn on "Allow HTML cards" in the bar to show it in a sandboxed frame.');
  return h('iframe', { ref, className: 'html-card', sandbox: 'allow-scripts allow-forms', srcDoc: FRAME_BRIDGE + card.html, title: card.title });
}

// What changed since the version before, line by line.
export function Changes({ card }) {
  const prev = (card.history || []).at(-1);
  if (!prev) return null;
  const before = String(prev.text ?? prev.body ?? prev.html ?? '').split('\n');
  const after = String(card.text ?? card.body ?? card.html ?? '').split('\n');
  const removed = before.filter((l) => !after.includes(l));
  const added = after.filter((l) => !before.includes(l));
  if (prev.title === card.title && !removed.length && !added.length) return null;
  return h('details', { className: 'changes' },
    h('summary', null, 'What changed since the agent last edited this card'),
    prev.title !== card.title && h('div', { className: 'del' }, `Title was: ${prev.title}`),
    removed.map((l, i) => h('div', { key: `r${i}`, className: 'del' }, `− ${l}`)),
    added.map((l, i) => h('div', { key: `a${i}`, className: 'add' }, `+ ${l}`)));
}

// The system card for new guidance: the person picks the agents, all of them at first.
export function BroadcastForm({ card, onDone }) {
  const [picked, setPicked] = React.useState(() => new Set(card.broadcast.agents));
  const send = (choice) => api(`${BASE}v1/cards/${card.id}/answer`, { values: { choice, agents: [...picked] } }).then(onDone);
  return h('div', { className: 'broadcast' },
    h('pre', null, card.broadcast.text),
    h('div', { className: 'agents' }, card.broadcast.agents.length ? card.broadcast.agents.map((a) => h('label', { key: a },
      h('input', { type: 'checkbox', checked: picked.has(a), onChange: () => setPicked((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; }) }), a))
      : h('span', null, 'No agent has connected yet. Agents get the guidance when they connect.')),
    h('div', { className: 'nav' },
      h('button', { className: 'btn primary', onClick: () => send('approve') }, 'Approve and send'),
      h('button', { className: 'btn', onClick: () => send('reject') }, 'Reject')));
}

export function HtmlToggle({ settings }) {
  // The switch moves at once; the inbox's change event confirms it.
  const [on, setOn] = React.useState(!!settings.allowHtml);
  React.useEffect(() => setOn(!!settings.allowHtml), [settings.allowHtml]);
  const toggle = () => {
    setOn(!on);
    fetch(BASE + 'v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-your-attention': '1' }, body: J({ allowHtml: !on }) });
  };
  return h('label', { className: 'notify', title: 'Show cards that bring their own HTML and scripts, in a sandboxed frame' },
    h('input', { type: 'checkbox', role: 'switch', checked: on, onChange: toggle }), 'Allow HTML cards');
}

export function NotifyToggle() {
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

export function presenceOf(card, state) {
  if (card.deliver === 'none') return null;
  const p = state.presence[card.agent];
  if (!p || !p.online) return ['off', 'Agent offline: your answer waits until its session resumes'];
  const unread = state.cards.some((c) => c.agent === card.agent && state.states[c.id] === 'delivered');
  return unread ? ['busy', 'Agent busy: it has an answer it has not read yet'] : ['on', 'Agent listening'];
}

