// The parts of the page, each one renderable alone, as the stories do.
import { BASE, CLOSED_LABEL, Icon, J, api, h, notifyOn, store } from './env.js';
import { renderMarkdown } from './markdown.js';

const { React, Renderer, openuiChatLibrary } = window.__OpenUI;

// OpenUI Lang for a card that brings no body of its own.
export function cardSource(c) {
  // A body with forms of its own keeps them where the agent placed them, and gets the comment and buttons below.
  if (c.body && /\bForm\(/.test(c.body)) return withAnswerFooter(c.body);
  // A body without a form of its own gets the generated answer form below it, so the card stays answerable.
  if (c.body && !c.options?.length && !c.questions?.length) return c.body;
  if (c.kind === 'blocked' && c.options && c.options.length) {
    // The sidecar read these choices from the agent's dialog, and presses the one you pick in that pane.
    return [
      'root = Card([screen, form])',
      `screen = CodeBlock("text", ${J(c.screen || '(screen unavailable)')})`,
      `form = Form(${J(c.id)}, buttons, [fcChoice])`,
      'fcChoice = FormControl("Your answer", choice)',
      `choice = OptionCards("choice", "single", [${c.options.map((_, j) => `c${j}`).join(', ')}])`,
      ...c.options.map((o, j) => `c${j} = OptionCard(${J(optionValue(o))}, ${J(o.label)}, "")`),
      'buttons = Buttons([save, go, skip], "row")',
      'save = Button("Press it in the session", @ToAssistant("send answer"), "primary")',
      'go = Button("Open session", @ToAssistant("open session"), "secondary")',
      'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
    ].join('\n');
  }
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
  if (c.body) { parts.push('custom'); L.push(c.body.replace(/^\s*root\s*=/m, 'custom =')); }
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
    c.options.forEach((o, j) => L.push(`c${j} = OptionCard(${J(optionValue(o))}, ${J(o.label)}, ${J(o.description || '')})`));
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

// Every card ends with the page's comment box, Send answer and Skip. The page's statements start with ya, so they leave
// the agent's names alone. A body with a field of its own named comment keeps it, and the answer joins both texts.
function withAnswerFooter(body) {
  return [
    'root = Card([yaBody, yaAnswer])',
    body.replace(/^\s*root\s*=/m, 'yaBody ='),
    'yaAnswer = Form("yaAnswer", yaButtons, [yaFcComment])',
    'yaFcComment = FormControl("Comment", yaComment)',
    'yaComment = TextArea("comment", "Anything to add?", 3)',
    'yaButtons = Buttons([yaSave, yaSkip], "row")',
    'yaSave = Button("Send answer", @ToAssistant("send answer"), "primary")',
    'yaSkip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
  ].join('\n');
}

/** The statements of OpenUI Lang source, by name: each `name = Call(args)` with its strings, numbers and references. */
export function parseSource(source) {
  const out = {};
  for (const line of String(source || '').split('\n')) {
    const m = /^\s*(\w+)\s*=\s*(\w+)\((.*)\)\s*$/.exec(line);
    if (!m) continue;
    try { out[m[1]] = { call: m[2], args: parseArgs(m[3]) }; } catch {}
  }
  return out;
}

function parseArgs(text) {
  let i = 0;
  const space = () => { while (/\s/.test(text[i] || '')) i++; };
  const value = () => {
    space();
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const s = JSON.parse(text.slice(i, j + 1));
      i = j + 1;
      return s;
    }
    if (ch === '[') { i++; const list = items(']'); return list; }
    if (ch === '{') {
      // An object inside the arguments, such as rules: skip to the matching close.
      const close = '}';
      let depth = 0;
      for (; i < text.length; i++) { if (text[i] === ch) depth++; else if (text[i] === close && --depth === 0) { i++; break; } else if (text[i] === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; } }
      return null;
    }
    const m = /^[@$]?[\w.-]+/.exec(text.slice(i));
    if (!m) throw new Error(`cannot read ${text.slice(i, i + 10)}`);
    i += m[0].length;
    space();
    if (text[i] === '(') { i++; return { call: m[0], args: items(')') }; }
    return /^-?\d/.test(m[0]) ? Number(m[0]) : { ref: m[0] };
  };
  const items = (end) => {
    const list = [];
    space();
    if (text[i] === end) { i++; return list; }
    for (;;) {
      list.push(value());
      space();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === end) { i++; return list; }
      throw new Error('expected a comma');
    }
  };
  text += '\u0000';
  return items('\u0000');
}

/** What each field of a card's own forms asks, and the label of each choice, read from the card's source. */
function fieldLabels(source) {
  const st = parseSource(source);
  // An argument is a reference to another statement, or a call written in place.
  const get = (v) => (v && v.ref ? st[v.ref] : v && v.call ? v : undefined);
  const fields = {};
  const field = (s, label) => {
    if (!s || typeof s.args[0] !== 'string') return;
    const choices = {};
    for (const it of Array.isArray(s.args[1]) ? s.args[1] : []) {
      const item = get(it);
      if (!item) continue;
      const [a0, , a2] = item.args;
      if (item.call === 'RadioItem') choices[a2] = a0;
      else if (item.call === 'SelectItem') choices[a0] = item.args[1];
      else if (item.call === 'OptionCard') choices[a0] = item.args[1];
      else if (item.call === 'CheckBoxItem' || item.call === 'SwitchItem') choices[a2] = a0;
    }
    fields[s.args[0]] = { label: label ?? fields[s.args[0]]?.label, choices };
  };
  for (const s of Object.values(st)) if (/^(RadioGroup|Select|OptionCards|CheckBoxGroup|SwitchGroup|Input|TextArea|Slider|DatePicker)$/.test(s.call)) field(s);
  for (const s of Object.values(st)) if (s.call === 'FormControl') field(get(s.args[1]), s.args[0]);
  return fields;
}

// A pick names the option's id and its label, so a pick stays only while the revised card still offers that option.
const optionValue = (o) => `${o.id}:${o.label}`;

/** The picks the card still offers, by option id. A revision that dropped or relabeled an option drops its pick. */
export function answerValues(card, values) {
  const out = { ...values };
  const keep = (key, lookup) => {
    if (!(key in out)) return;
    const picked = [out[key]].flat().filter((v) => lookup.has(v)).map((v) => lookup.get(v));
    if (Array.isArray(out[key])) out[key] = picked;
    else if (picked.length) out[key] = picked[0];
    else delete out[key];
  };
  keep('choice', new Map((card.options || []).map((o) => [optionValue(o), o.id])));
  (card.questions || []).forEach((q, i) => keep(`q${i}`, new Map((q.options || []).map((o) => [o.label, o.label]))));
  return out;
}

// Form values by field name, without the comment.
export function formValues(formState) {
  const values = {};
  // A body's own comment field comes first, and the page's comment box under the card comes last.
  const comments = [];
  const walk = (o, footer) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && 'value' in v) {
        if (k === 'comment') comments.push([footer, String(v.value || '').trim()]);
        else values[k] = v.value;
      } else walk(v, footer || k === 'yaAnswer');
    }
  };
  walk(formState, false);
  const comment = comments.sort((a, b) => Number(a[0]) - Number(b[0])).map(([, t]) => t).filter(Boolean).join('\n');
  return { values, comment };
}

export function describe(card, a) {
  if (!a) return '';
  if (card.kind === 'secret') return [a.values && a.values.sealed ? 'Sent sealed' : 'Declined', a.comment].filter(Boolean).join('\n');
  let fields;
  const picks = Object.entries(a.values || {}).map(([k, v]) => {
    const list = [].concat(v);
    if (k === 'choice' && card.options) return list.map((x) => (card.options.find((o) => o.id === x) || {}).label || x).join(', ');
    const qi = /^q(\d+)$/.exec(k);
    if (qi && card.questions) return `${card.questions[Number(qi[1])]?.question || k} ${list.join(', ')}`;
    const f = (fields ??= fieldLabels(card.body))[k];
    // A check box or switch group answers with each item on or off: the summary lists the ones turned on.
    const picked = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((x) => v[x]) : list;
    const shown = picked.map((x) => (f && f.choices[x]) || x).join(', ');
    if (!shown) return '';
    // A field without a label keeps its name, unless its choices carry the labels, as a switch group's do.
    const label = (f && f.label) || (f && Object.keys(f.choices).length ? '' : k);
    return label ? `${label}: ${shown}` : shown;
  });
  return [...picks, a.comment].filter(Boolean).join('\n') || 'Empty answer';
}

// One rendered card. Its initial state is read once, so later renders keep what you typed.
export function CardView({ draftKey, response, onAction }) {
  const [initialState] = React.useState(() => store.get(draftKey) || undefined);
  const actionRef = React.useRef(onAction);
  actionRef.current = onAction;
  // A button sends only its own form's state. A card can hold several forms, so the answer takes all of them.
  const stateRef = React.useRef(initialState);
  const handlers = React.useMemo(() => ({
    onStateUpdate: (s) => { stateRef.current = s; store.set(draftKey, s); },
    onAction: (ev) => actionRef.current({ ...ev, formState: stateRef.current || ev.formState }),
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
      h('button', { className: 'btn', onClick: () => setCollapsed((c) => !c) }, collapsed ? 'Show card' : 'Hide card'),
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

// A session link opens another agent's session in herdr through the inbox, which runs herdr on this computer.
// The link says whether it worked, since the session opens in the terminal and the page does not change.
export async function openSessionLink(href, el) {
  const res = await api(`${BASE}v1/focus`, { href }).catch(() => null);
  const error = !res ? 'The inbox did not answer.' : res.ok ? '' : ((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
  if (!el) return;
  el.dataset.opened = error ? '' : 'Opened in herdr';
  el.dataset.failed = error ? `Could not open: ${error}` : '';
  el.title = error ? `Could not open: ${error}` : 'Opened in herdr';
}

// Card text with [[card-id]] links. A link shows the linked card title, and its text on hover.
// Card text is Markdown, and [[card-id]] links to another card by its title.
export function LinkedText({ text, byId, open }) {
  const cardLink = (id, key) => {
    const target = byId[id];
    if (!target) return h('span', { key, className: 'dead-link', title: 'This card is not in the inbox' }, id);
    const preview = [target.title, target.text].filter(Boolean).join('\n\n').slice(0, 400);
    return h('a', { key, className: 'card-link', title: preview, onClick: () => open(target.id) }, target.title);
  };
  return h('div', { className: 'card-text markdown' }, renderMarkdown(h, text, { cardLink, breaks: true }));
}

export const isImage = (t) => /^image\/(png|jpeg|gif|webp)$/.test(t);
// An agent's URL is used only when it is https: a javascript: or data: link must never reach an href.
export const fileUrl = (f) => (f.id ? `${BASE}v1/attachments/${encodeURIComponent(f.id)}` : /^https:\/\//i.test(String(f.url || '')) ? f.url : 'about:blank');
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
  // Only the inbox's own copy of a PDF goes in a frame: the inbox serves it as application/pdf with nosniff,
  // so the browser can only show it as a PDF. A sandboxed frame cannot run the PDF viewer. A PDF elsewhere stays a link.
  if (file.type === 'application/pdf' && file.id) body = h('iframe', { className: 'pdf', src: fileUrl(file), title: file.name });
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
// The frame may not load or send anything over the network: the card shows only what it brings.
export const FRAME_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;
// Links open in a new tab: a page loaded inside the frame would run sandboxed, and most sites refuse to be framed.
export const FRAME_LINKS = '<base target="_blank">';
// The frame also reports its content height, so the page sizes it to fit and the card has one scroll: the page's.
// It measures the root element, not the scroll height, which is never less than the frame: a short card would grow on each report.
export const FRAME_BRIDGE = '<script>window.yourAttention={answer:function(v,c){parent.postMessage({yourAttention:"answer",values:v||{},comment:c||""},"*")}};'
  + '(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;parent.postMessage({yourAttention:"height",height:h},"*")}}'
  + 'new ResizeObserver(send).observe(document.documentElement);addEventListener("load",send)})();'
  // A session link opens in herdr through the page, not in a new tab.
  + 'addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a||a.href.indexOf("https://herdr.invalid/v1/")!==0)return;'
  + 'e.preventDefault();parent.postMessage({yourAttention:"session",href:a.href},"*")},true);'
  // The page's Send answer asks the frame for its form: every named field, a radio's picked value, each checked box.
  + 'addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.yourAttention!=="collect")return;var v={};'
  + 'document.querySelectorAll("input[name],select[name],textarea[name]").forEach(function(el){var n=el.name,t=el.type;'
  + 'if(t==="radio"){if(el.checked)v[n]=el.value}else if(t==="checkbox"){if(el.checked)(v[n]=v[n]||[]).push(el.value)}'
  + 'else if(t==="button"||t==="submit"||t==="reset"||t==="hidden"){}else if(el.multiple){v[n]=[].map.call(el.selectedOptions,function(o){return o.value})}'
  + 'else if(el.value!=="")v[n]=el.value});parent.postMessage({yourAttention:"collected",id:e.data.id,values:v},"*")});<\/script>';
/**
 * The app's text styles for an HTML card, placed after the agent's own CSS: its font, weight, spacing, text size and
 * colors, with the dim color for body text and the bright one for headings and bold words, and monospace for code. The agent keeps its layout, but every card reads the same as the rest of the inbox.
 */
function frameTheme() {
  const root = getComputedStyle(document.documentElement);
  const token = (name) => root.getPropertyValue(name).trim();
  const size = getComputedStyle(document.body).fontSize;
  // A custom property that holds color-mix() reads back unresolved, so the frame gets the computed color.
  const probe = document.createElement('span');
  probe.style.color = 'var(--body-text)';
  document.body.append(probe);
  const bodyText = getComputedStyle(probe).color;
  probe.remove();
  const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  return `<style>:root{color-scheme:${dark ? 'dark' : 'light'}}`
    + `html,body{background:${token('--panel')} !important;color:${bodyText} !important;font-family:${token('--font-text')} !important;`
    + `font-size:${size} !important;line-height:1.5 !important;font-weight:200 !important;letter-spacing:.02em !important}`
    + 'body *{font-family:inherit !important;font-weight:inherit !important;letter-spacing:inherit !important}'
    + 'body *:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6){font-size:inherit !important}'
    + `h1,h2,h3,h4,h5,h6,b,strong,th{font-weight:300 !important;color:${token('--ink')} !important}`
    + `code,code *,pre,pre *,kbd,samp{font-family:${token('--font-code')} !important;letter-spacing:normal !important}`
    + `a[href^="https://herdr.invalid/v1/"]{color:${token('--accent')} !important;cursor:pointer}</style>`;
}
/** The tallest frame the page makes, so a card cannot grow the page without bound. The frame's height also takes its 2px of border. */
const MAX_FRAME_HEIGHT = 20000;
/** Turn showing HTML cards on or off for the whole inbox. */
const setAllowHtml = (on) => fetch(BASE + 'v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-your-attention': '1' }, body: J({ allowHtml: on }) });

// A card with the agent's own HTML. It shows only when the owner allows HTML cards, or asks to see this one.
export function HtmlCard({ card, allowed, onAnswer, onSkip }) {
  const ref = React.useRef(null);
  // The comment draft belongs to the card, not its version, so a revision keeps what the person typed.
  const draftKey = `draft:${card.id}:comment`;
  const [comment, setComment] = React.useState(() => store.get(draftKey) || '');
  const commentRef = React.useRef(comment);
  commentRef.current = comment;
  const pending = React.useRef(new Map());
  const [once, setOnce] = React.useState(null);
  const [always, setAlways] = React.useState(allowed);
  const [height, setHeight] = React.useState(null);
  React.useEffect(() => setAlways(allowed), [allowed]);
  React.useEffect(() => {
    const listen = (e) => {
      if (!ref.current || e.source !== ref.current.contentWindow || !e.data) return;
      if (e.data.yourAttention === 'height') { const px = Number(e.data.height); if (px > 0) setHeight(Math.min(px, MAX_FRAME_HEIGHT)); return; }
      const values = typeof e.data.values === 'object' && e.data.values ? e.data.values : {};
      if (e.data.yourAttention === 'session') { if (typeof e.data.href === 'string') openSessionLink(e.data.href, ref.current); return; }
      if (e.data.yourAttention === 'collected') { pending.current.get(e.data.id)?.(values); return; }
      if (e.data.yourAttention !== 'answer') return;
      // An answer from the card's own button carries the comment from the page's box too.
      onAnswer(values, [String(e.data.comment || '').trim(), commentRef.current.trim()].filter(Boolean).join('\n'));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [card.id, card.version]);
  const allow = (on) => { setAlways(on); setAllowHtml(on); };
  // Send answer takes what the frame's form holds, or nothing when the frame is hidden or does not reply.
  const collect = () => new Promise((resolve) => {
    const frame = ref.current && ref.current.contentWindow;
    if (!frame) return resolve({});
    const id = Math.random().toString(36).slice(2);
    const done = (v) => { pending.current.delete(id); clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done({}), 1500);
    pending.current.set(id, done);
    frame.postMessage({ yourAttention: 'collect', id }, '*');
  });
  const footer = h('div', { className: 'html-answer' },
    h('label', null, 'Comment', h('textarea', { rows: 3, value: comment, placeholder: 'Anything to add?', onChange: (e) => { setComment(e.target.value); store.set(draftKey, e.target.value); } })),
    h('div', { className: 'html-answer-actions' },
      h('button', { type: 'button', className: 'btn primary', onClick: async () => { onAnswer(await collect(), comment.trim()); store.del(draftKey); } }, 'Send answer'),
      h('button', { type: 'button', className: 'btn', onClick: onSkip }, 'Skip for now')));
  if (!always && once !== card.id) {
    return h(React.Fragment, null, h('div', { className: 'note warn html-gate' },
      h('p', null, 'This card brings its own HTML and scripts. They run in a sandboxed frame that cannot reach the network or this page. A click in the card can open a page in a new tab, and the card chooses its address.'),
      h('div', { className: 'html-gate-actions' },
        h('button', { type: 'button', className: 'btn primary', onClick: () => setOnce(card.id) }, 'Show this card'),
        h('button', { type: 'button', className: 'btn', onClick: () => allow(true) }, 'Always show HTML cards'))), footer);
  }
  return h(React.Fragment, null,
    // The new tab leaves the sandbox, so the linked page works as it does anywhere. It opens without a reference back to this page.
    h('iframe', { ref, className: 'html-card', style: height ? { height: `calc(${height}px + 2px)` } : undefined, sandbox: 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox', srcDoc: FRAME_POLICY + FRAME_LINKS + FRAME_BRIDGE + card.html + frameTheme(), title: card.title }),
    always
      ? h('button', { type: 'button', className: 'link html-off', onClick: () => { setOnce(null); allow(false); } }, 'Stop showing HTML cards')
      : h('button', { type: 'button', className: 'link html-off', onClick: () => allow(true) }, 'Always show HTML cards'),
    footer);
}

// What changed since the version before, line by line.
// Every revision, newest first: for each one, the lines it removed and added in each field.
const FIELDS = [['title', 'Title'], ['text', 'Text'], ['recommendation', 'Recommendation'], ['body', 'Body'], ['html', 'HTML']];
function diff(before, after) {
  const b = String(before ?? '').split('\n');
  const a = String(after ?? '').split('\n');
  return { removed: b.filter((l) => l && !a.includes(l)), added: a.filter((l) => l && !b.includes(l)) };
}
// The words that differ between a removed line and the added line that replaced it,
// from the longest common run of words. Lines that share no word, or are very long,
// get no word marks: the whole line changed.
export function wordDiff(before, after) {
  const x = before.split(/(\s+)/);
  const y = after.split(/(\s+)/);
  if (x.length * y.length > 250000) return null;
  const t = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const del = [];
  const add = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { del.push([x[i++], false]); add.push([y[j++], false]); }
    else if (t[i + 1][j] >= t[i][j + 1]) del.push([x[i++], true]);
    else add.push([y[j++], true]);
  }
  while (i < x.length) del.push([x[i++], true]);
  while (j < y.length) add.push([y[j++], true]);
  if (!del.some(([w, changed]) => !changed && w.trim())) return null;
  return { del, add };
}
const marked = (words) => words.map(([w, changed], k) => (changed && w.trim() ? h('mark', { key: k }, w) : w));

export function Changes({ card }) {
  const versions = [...(card.history || []), card];
  const steps = [];
  for (let i = versions.length - 1; i > 0; i--) {
    const before = versions[i - 1];
    const after = versions[i];
    const fields = FIELDS.map(([k, label]) => ({ label, ...diff(before[k], after[k]) })).filter((f) => f.removed.length || f.added.length);
    if (fields.length) steps.push({ version: after.version, fields });
  }
  if (!steps.length) return null;
  return h('details', { className: 'changes' },
    h('summary', null, steps.length === 1 ? 'What changed in the last edit' : `What changed, edit by edit (${steps.length} edits)`),
    steps.map((s) => h('div', { key: s.version, className: 'step' },
      h('div', { className: 'step-head' }, `Version ${s.version}`),
      s.fields.map((f) => h('div', { key: f.label },
        h('div', { className: 'field' }, f.label),
        f.removed.map((l, i) => { const w = i < f.added.length && wordDiff(l, f.added[i]); return h('div', { key: `r${i}`, className: 'del' }, '− ', w ? marked(w.del) : l); }),
        f.added.map((l, i) => { const w = i < f.removed.length && wordDiff(f.removed[i], l); return h('div', { key: `a${i}`, className: 'add' }, '+ ', w ? marked(w.add) : l); }))))));
}

// An agent's name for people: the session name its newest card carries, else its id.
export function agentName(id, cards) {
  let best = null;
  for (const c of cards) if (c.agent === id && c.origin && c.origin.name && (!best || c.createdAt > best.createdAt)) best = c;
  return best ? best.origin.name : id;
}

// The system card for new guidance: the person picks the agents, all of them at first.
export function BroadcastForm({ card, cards = [], onDone }) {
  const [picked, setPicked] = React.useState(() => new Set(card.broadcast.agents));
  const send = (choice) => api(`${BASE}v1/cards/${card.id}/answer`, { values: { choice, agents: [...picked] } }).then(onDone);
  return h('div', { className: 'broadcast' },
    h('pre', null, card.broadcast.text),
    h('div', { className: 'agents' }, card.broadcast.agents.length ? card.broadcast.agents.map((a) => h('label', { key: a },
      h('input', { type: 'checkbox', checked: picked.has(a), onChange: () => setPicked((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; }) }), agentName(a, cards)))
      : h('span', null, 'No agent has connected yet. Agents get the guidance when they connect.')),
    h('div', { className: 'nav' },
      h('button', { className: 'btn primary', onClick: () => send('approve') }, 'Approve and send'),
      h('button', { className: 'btn', onClick: () => send('reject') }, 'Reject')));
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


// The inbox address as a QR code, to open the inbox on a phone. The code in the QR signs one phone in once, within five minutes.
export function PhoneLink() {
  const [open, setOpen] = React.useState(false);
  const [qr, setQr] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const ref = React.useRef(null);
  // A phone cannot reach an address that names this computer itself, so a laptop inbox gives its network addresses.
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  const [network, setNetwork] = React.useState([]);
  const address = (local && network[0] ? network[0] : location.origin) + location.pathname;
  React.useEffect(() => {
    if (!open) return;
    if (ref.current && !ref.current.open) ref.current.showModal();
    let live = true;
    let renew;
    const draw = (qrcode, text) => {
      const code = qrcode(0, 'M');
      code.addData(text);
      code.make();
      const n = code.getModuleCount();
      let d = '';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (code.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
      return { n, d };
    };
    // The QR code waits for the network address, so it never encodes this computer's own name.
    const where = local
      ? api(`${BASE}v1/addresses`).then((r) => (r.ok ? r.json() : {})).then((d) => d.addresses || [], () => [])
      : Promise.resolve([]);
    where.then((list) => { if (live) setNetwork(list); });
    const load = import(/* @vite-ignore */ new URL('vendor/qrcode.mjs', document.baseURI).href);
    // Ask for a fresh sign-in code, and another one shortly before it expires while the dialog stays open.
    const refresh = () => Promise.all([load, where, api(`${BASE}v1/sign-in-codes`, {}).then((r) => (r.ok ? r.json() : null)).catch(() => null)])
      .then(([{ default: qrcode }, list, signin]) => {
        if (!live) return;
        const target = (list[0] || location.origin) + location.pathname;
        setQr({ ...draw(qrcode, signin ? `${target}#signin=${signin.code}` : target), signsIn: !!signin });
        if (signin) renew = setTimeout(refresh, Math.max(10_000, signin.expiresAt - Date.now() - 30_000));
      }, () => { if (live) setQr({ failed: true }); });
    refresh();
    return () => { live = false; clearTimeout(renew); };
  }, [open]);
  const close = () => { ref.current?.close(); setOpen(false); setCopied(false); setQr(null); };
  const copy = () => navigator.clipboard?.writeText(address).then(() => setCopied(true), () => {});
  return h(React.Fragment, null,
    h('button', { type: 'button', className: 'phone', onClick: () => setOpen(true), 'aria-label': 'Open this inbox on your phone', title: 'Open this inbox on your phone' },
      h('svg', { viewBox: '0 0 16 16', width: 22, height: 22, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
        h('rect', { x: 4, y: 1, width: 8, height: 14, rx: 1.75 }),
        h('path', { d: 'M7 12.5h2', strokeLinecap: 'round' }))),
    open && h('dialog', { ref, className: 'qr-dialog', onClose: close, onClick: (e) => { if (e.target === ref.current) close(); }, 'aria-labelledby': 'qr-title' },
      h('h2', { id: 'qr-title' }, 'Open this inbox on your phone'),
      h('p', null, 'Scan the code with the phone camera. The phone opens the inbox signed in.'),
      h('div', { className: 'qr' }, qr && qr.failed
        ? h('p', { className: 'qr-failed' }, 'The QR code did not load. Copy the address below instead.')
        : qr
        ? h('svg', { viewBox: `-4 -4 ${qr.n + 8} ${qr.n + 8}`, role: 'img', 'aria-label': `QR code that opens ${address}`, shapeRendering: 'crispEdges' },
          h('rect', { x: -4, y: -4, width: qr.n + 8, height: qr.n + 8, fill: '#fff' }), h('path', { d: qr.d, fill: '#000' }))
        : h('span', { className: 'muted' }, 'Drawing the code…')),
      h('p', { className: 'qr-address' }, address),
      local && network.length > 1 && h('p', { className: 'muted' }, 'Your phone must be on the same network. If its camera cannot open the name, try ', h('code', null, network[1] + location.pathname), '.'),
      local && !network.length && h('p', { className: 'note warn' }, 'This address names this computer, so a phone cannot open it. Open this page at the computer\'s network address instead, such as ', h('code', null, 'http://<name>.local:4815'), ', or use a cloud inbox.'),
      qr && h('p', { className: 'muted' }, qr.signsIn
        ? 'The code signs one phone in, once, within five minutes. Anyone who scans it first gets in, so keep it to yourself.'
        : 'This address has no sign-in. On the phone, sign in with your owner link.'),
      h('div', { className: 'qr-actions' },
        h('button', { type: 'button', className: 'btn', onClick: copy }, copied ? 'Copied' : 'Copy the address'),
        h('button', { type: 'button', className: 'btn primary', onClick: close, autoFocus: true }, 'Close'))));
}
