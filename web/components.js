// The parts of the page, each one renderable alone, as the stories do.
import { BASE, CLOSED_LABEL, ICONS, Icon, J, api, h, notifyOn, store } from './env.js';
import { cardAge } from './age.js';
import { extendLibrary } from './library-spec.js';
import { bodyFaults, fallbackSources } from './body-faults.js';
import { SESSION_LINK, codeBlock, renderInline, renderMarkdown } from './markdown.js';
import { installCopy } from './copy.js';
import { answerValues, cardSource, changeSteps, describe, formValues, optionValue, parseSource, recommendedOptions } from './answers.js';

import { agentName, presenceOf } from './queue.js';

export { agentName, answerValues, cardSource, describe, formValues, parseSource, presenceOf, recommendedOptions };

const { React, Renderer, openuiChatLibrary } = window.__OpenUI;
// Code on every card copies with a click, on the page and in each story.
installCopy();

// CheckWithText(label, check, [content]): a check box, and a label that shows the content when clicked, such as text the
// person can edit before the agent uses it. Hovering the label previews the text. The label never ticks the box.
function CheckWithText({ props, renderNode }) {
  const [open, setOpen] = React.useState(false);
  const [tip, setTip] = React.useState('');
  const box = React.useRef(null);
  const preview = () => setTip([...(box.current ? box.current.querySelectorAll('textarea, input') : [])].map((el) => el.value).filter(Boolean).join('\n\n'));
  React.useEffect(preview, []);
  return h('div', { className: 'check-with-text' },
    h('div', { className: 'row' }, renderNode(props.check),
      h('button', { type: 'button', className: 'reveal', 'aria-expanded': open, title: tip, onMouseEnter: preview, onFocus: preview, onClick: () => setOpen((o) => !o) }, props.label)),
    // The content stays rendered while hidden, so its fields keep their values and send them with the answer.
    h('div', { ref: box, className: 'revealed', hidden: !open, onInput: preview }, renderNode(props.content)));
}
// Mermaid(source): a diagram, drawn with the mermaid build the inbox serves. A laptop inbox checked the source with
// this version when the card was posted, so it draws. Diagrams draw one at a time, since mermaid keeps one in progress.
export const MERMAID_VERSION = '11.17.2';
let mermaidLoad = null;
let drawing = Promise.resolve();
let drawn = 0;
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${BASE}vendor/mermaid.min.js?v=${MERMAID_VERSION}`;
    s.onload = () => resolve(window.mermaid);
    s.onerror = () => { mermaidLoad = null; s.remove(); reject(Object.assign(new Error('the diagram renderer did not load'), { unloaded: true })); };
    document.head.append(s);
  });
  return mermaidLoad;
}
export const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
// The base theme takes the page's colors, so a diagram reads in the light theme and in the dark one.
function diagramTheme() {
  const root = getComputedStyle(document.documentElement);
  const t = (name) => root.getPropertyValue(name).trim();
  const dark = isDark();
  return { theme: 'base', darkMode: dark, fontFamily: t('--font-text'), themeVariables: {
    darkMode: dark, fontFamily: t('--font-text'), background: t('--panel'), textColor: t('--ink'), titleColor: t('--ink'), lineColor: t('--muted'),
    primaryColor: t('--info-bg'), primaryTextColor: t('--ink'), primaryBorderColor: t('--info'),
    secondaryColor: t('--ok-bg'), secondaryTextColor: t('--ink'), secondaryBorderColor: t('--ok'),
    tertiaryColor: t('--bg'), tertiaryTextColor: t('--ink'), tertiaryBorderColor: t('--line'),
    clusterBkg: t('--bg'), clusterBorder: t('--line'), edgeLabelBackground: t('--panel'),
    noteBkgColor: t('--warn-bg'), noteTextColor: t('--ink'), noteBorderColor: t('--warn'),
    actorBkg: t('--info-bg'), actorBorder: t('--info'), actorTextColor: t('--ink'), actorLineColor: t('--muted'), signalColor: t('--ink'), signalTextColor: t('--ink'),
  } };
}
function drawDiagram(source) {
  const run = drawing.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, ...diagramTheme() });
    return (await mermaid.render(`diagram-${++drawn}`, source)).svg;
  });
  drawing = run.catch(() => {});
  return run;
}
function useDark() {
  const [dark, setDark] = React.useState(isDark);
  React.useEffect(() => {
    const q = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(isDark());
    q.addEventListener('change', on);
    // A page that sets data-theme on the root switches the theme too.
    const attr = new MutationObserver(on);
    attr.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { q.removeEventListener('change', on); attr.disconnect(); };
  }, []);
  return dark;
}

// A page that cannot draw a diagram, or all of a body, tells the inbox, and the inbox sends the card back to its agent with
// the errors. The hosted inbox takes both unchecked, so an agent whose client skipped the check hears of it this way.
export const DrawFaults = React.createContext(null);
const reporters = new Map();
/** The reporter for one version of a card, or null for a card the inbox would not send back. */
export function drawFaultsOf(card) {
  if (!card || card.kind === 'system' || card.closed) return null;
  const key = `${card.id}:${card.version}`;
  if (!reporters.has(key)) {
    const diagrams = new Map();
    let body = null;
    let timer = null;
    // Faults that show up together go in one report, so the agent reads them in one message.
    // Each fault goes out once: `sent` remembers it, and a flush sends only what came since the last one.
    const sent = new Set();
    const flush = () => {
      timer = null;
      const report = { version: card.version, renderer: MERMAID_VERSION, diagrams: [...diagrams].map(([source, error]) => ({ source, error })), ...(body ? { body } : {}) };
      diagrams.clear();
      body = null;
      api(`${BASE}v1/cards/${encodeURIComponent(card.id)}/draw-fault`, report).catch(() => {});
    };
    const later = () => { timer ??= setTimeout(flush, 300); };
    // A page open for days shows many card versions, so it forgets the oldest reporters.
    if (reporters.size >= 200) reporters.delete(reporters.keys().next().value);
    reporters.set(key, {
      diagram(source, error) { if (!sent.has(`d:${source}`)) { sent.add(`d:${source}`); diagrams.set(source, error); later(); } },
      body(faults) { if (!sent.has('body')) { sent.add('body'); body = faults; later(); } },
    });
  }
  return reporters.get(key);
}

export function Diagram({ source }) {
  const dark = useDark();
  const faults = React.useContext(DrawFaults);
  const [drawn, setDrawn] = React.useState({ svg: '', failed: '' });
  React.useEffect(() => {
    let live = true;
    drawDiagram(source).then((svg) => live && setDrawn({ svg, failed: '' }), (e) => {
      if (!live) return;
      const failed = String(e?.message || e);
      setDrawn({ svg: '', failed });
      // A renderer that did not load says nothing about the diagram.
      if (!e?.unloaded) faults?.diagram(source, failed);
    });
    return () => { live = false; };
  }, [source, dark]);
  // Should drawing fail all the same, such as when the renderer does not load, the person reads the source.
  if (drawn.failed) return codeBlock(h, source, undefined, { className: 'diagram-source', title: `The diagram did not draw: ${drawn.failed}` });
  // mermaid's strict security level sanitizes the SVG it returns.
  return h('figure', { className: 'diagram', role: 'img', 'aria-label': `Diagram: ${source.split('\n')[0]}`, dangerouslySetInnerHTML: { __html: drawn.svg } });
}

// A field label reads Markdown, as card text does, so a label can link to the pull request it asks about.
const PlainFormControl = openuiChatLibrary.components.FormControl.component;
const MarkdownFormControl = (args) => PlainFormControl({ ...args, props: { ...args.props, label: h(React.Fragment, null, renderInline(h, args.props.label)) } });
// The option a card recommends shows a Recommended tag, and the card's recommendation, below its description.
// CardView gives the recommended option values and the recommendation to the `choice` field the page builds from the options.
const Recommended = React.createContext(null);
const RECOMMENDED = { type: 'recommended-option' };
function RecommendedNote({ note }) {
  // A link in the recommendation opens without picking the option around it.
  return h('div', { className: 'rec-in-option', onClick: (e) => { if (e.target.closest('a')) e.stopPropagation(); } },
    h('strong', { className: 'rec-tag' }, 'Recommended'), note);
}
const PlainOptionCards = openuiChatLibrary.components.OptionCards.component;
function RecommendingOptionCards(args) {
  const rec = React.useContext(Recommended);
  if (!rec || args.props.name !== 'choice') return PlainOptionCards(args);
  // OpenUI draws an option's top content through renderNode, so the note goes there and the stylesheet moves it below the text.
  const items = (args.props.items || []).map((it) => (rec.values.includes(it?.props?.value) ? { ...it, props: { ...it.props, topContent: RECOMMENDED } } : it));
  const renderNode = (n) => (n === RECOMMENDED ? h(RecommendedNote, { note: rec.note }) : args.renderNode(n));
  return PlainOptionCards({ ...args, props: { ...args.props, items }, renderNode });
}
const library = extendLibrary(openuiChatLibrary, {
  CheckWithText,
  Mermaid: ({ props }) => h(Diagram, { source: String(props.source ?? '') }),
  FormControl: MarkdownFormControl,
  OptionCards: RecommendingOptionCards,
});
/** The page's component list, as the inbox reads it from src/adapters/openui-library.ts. */
export const librarySchema = () => library.toJSONSchema();
// The same list with components that draw nothing. A hidden Renderer reads a body with it, for its parse result alone.
let parseOnly = null;
const parseOnlyLibrary = () => (parseOnly ??= library.extend({ components: { override: Object.values(library.components).map((c) => ({ ...c, component: () => null })) } }));

/** Reads a body with the OpenUI parser, as the inbox does, and draws nothing. */
function BodyCheck({ body, onParsed }) {
  return h('div', { hidden: true, 'data-body-check': '' }, h(Renderer, { response: body, library: parseOnlyLibrary(), onParseResult: (p) => p && p.meta && onParsed(p) }));
}

// One rendered card. Its initial state is read once, so later renders keep what you typed.
// A body may not draw whole: one stored before the laptop inbox checked bodies, for which the inbox sends `bodyFallback`,
// or one the hosted inbox took unchecked. For that one the page finds the faults itself, draws the same fallback, and
// reports the faults, so the card goes back to its agent.
export function CardView({ draftKey, card, onAction, recommendationText }) {
  const faultsTo = React.useContext(DrawFaults);
  const [own, setOwn] = React.useState(null);
  const body = card.body;
  const checks = !card.bodyFallback && body !== undefined;
  const mine = checks && own && own.body === body ? own : null;
  React.useEffect(() => { if (mine && mine.faults.length) faultsTo?.body(mine.faults); }, [mine && mine.faults]);
  // The partial fallback draws only when it reads whole itself. Otherwise the source alone does.
  const fallback = card.bodyFallback ? card.bodyFallback.body : mine && mine.use ? mine[mine.use] : undefined;
  const checker = !checks ? null
    : !mine ? h(BodyCheck, { key: 'body', body, onParsed: (p) => {
      const faults = bodyFaults(body, p);
      const sources = faults.length ? fallbackSources(body, p) : {};
      setOwn({ body, faults, ...sources, use: faults.length && sources.partial === undefined ? 'whole' : null });
    } })
    : mine.faults.length && !mine.use
      ? h(BodyCheck, { key: 'partial', body: mine.partial, onParsed: (p) => setOwn({ ...mine, use: bodyFaults(mine.partial, p).length ? 'whole' : 'partial' }) })
      : null;
  // `recommendationText` draws a recommendation as the page does, for the option it recommends.
  const { ids, text } = recommendedOptions(card);
  const values = (card.options || []).filter((o) => ids.includes(o.id)).map(optionValue);
  const rec = values.length ? { values, note: text && recommendationText ? recommendationText(text) : null } : null;
  return h(React.Fragment, null, checker, h(Recommended.Provider, { value: rec },
    h(CardBody, { draftKey, response: cardSource(fallback !== undefined ? { ...card, body: fallback } : card), broken: fallback !== undefined, onAction })));
}

function CardBody({ draftKey, response, broken, onAction }) {
  const [initialState] = React.useState(() => store.get(draftKey) || undefined);
  const actionRef = React.useRef(onAction);
  actionRef.current = onAction;
  // A button sends only its own form's state. A card can hold several forms, so the answer takes all of them.
  const stateRef = React.useRef(initialState);
  const handlers = React.useMemo(() => ({
    onStateUpdate: (s) => { stateRef.current = s; store.set(draftKey, s); },
    onAction: (ev) => actionRef.current({ ...ev, formState: stateRef.current || ev.formState }),
  }), [draftKey]);
  // One Renderer in one place draws both, so a swap keeps what the person typed, as a revision does.
  return h(React.Fragment, null,
    broken && h('div', { className: 'note warn' }, 'Part of this card did not draw, because its body has an error. The source from that error on is at the end of the card.'),
    h('div', { className: broken ? 'body-source' : 'card-body' }, h(Renderer, { response, library, initialState, ...handlers })));
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
      h('span', { className: 'secret-field' },
        h('svg', { className: 'key-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, ICONS.key.map((d) => h('path', { key: d, d }))),
        h('input', { type: 'password', autoComplete: 'off', spellCheck: false, value, onChange: (e) => setValue(e.target.value) }))),
    h('label', null, 'Comment', h('textarea', { rows: 2, value: comment, onChange: (e) => setComment(e.target.value), placeholder: 'Anything to add?' })),
    error && h('div', { className: 'note warn' }, error),
    h('div', { className: 'nav' },
      h('button', { className: 'btn primary', type: 'submit', disabled: !value }, 'Send sealed'),
      h('button', { className: 'btn', type: 'button', onClick: () => send(false) }, 'Decline'),
      h('button', { className: 'btn', type: 'button', onClick: onSkip }, 'Skip for now')),
    h('p', { className: 'hint' }, 'Your browser encrypts the value for this session only. The inbox stores the ciphertext, and the model sees a file path, never the value.'));
}

// How long ago the agent sent the card, roughly. It moves on at each turn of the clock's minute.
export function CardAge({ card }) {
  // The tick only re-renders: each render reads the clock, so a card opened between ticks shows its own age.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    let timer;
    const tick = () => { setTick((n) => n + 1); timer = setTimeout(tick, 60_000 - (Date.now() % 60_000)); };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, []);
  const sent = `Sent ${new Date(card.createdAt).toLocaleString()}`;
  const tip = card.updatedAt > card.createdAt + 60_000 ? `${sent}, revised ${new Date(card.updatedAt).toLocaleString()}` : sent;
  return h('span', { className: 'age', title: tip }, cardAge(Date.now() - card.createdAt));
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
// A ```mermaid block draws as a diagram, except on a system card, which quotes an agent's words as they are.
/** Open a card's file in a new tab. A new tab sends no unlock header, so it opens the file with a ticket that this page
 * asks for, good once. The tab opens at the click, since a popup blocker stops one that opens after a fetch. */
export function openCardFile(card, path) {
  const tab = window.open('', '_blank');
  if (!tab) return;
  tab.opener = null;
  const route = `${BASE}v1/cards/${encodeURIComponent(card)}/file`;
  api(`${route}-ticket`, { path })
    .then((r) => r.json().then((d) => {
      if (!r.ok) throw new Error(d.error || `the inbox answered ${r.status}`);
      tab.location.href = new URL(`${route}?ticket=${encodeURIComponent(d.ticket)}`, location.href).href;
    }))
    .catch((e) => { tab.document.title = 'File not opened'; tab.document.body.textContent = `The file did not open: ${e.message}`; });
}

// With a card id in `files`, a file: link opens the file in a new tab, which the laptop inbox serves for that card only.
// Without one, as on the hosted inbox or for a card from another machine, the link shows its path as code.
export function LinkedText({ text, byId, open, diagrams = true, files }) {
  const cardLink = (id, key) => {
    const target = byId[id];
    if (!target) return h('span', { key, className: 'dead-link', title: 'This card is not in the inbox' }, id);
    // The state sends the start of each card's text as its preview.
    const preview = [target.title, target.preview ?? target.text].filter(Boolean).join('\n\n').slice(0, 400);
    return h('a', { key, className: 'card-link', title: preview, onClick: () => open(target.id) }, target.title);
  };
  const diagram = diagrams ? (source, key) => h(Diagram, { key, source }) : undefined;
  const fileLink = files ? (path, label, key) => h('a', { key, className: 'file-link', title: path,
    href: `${BASE}v1/cards/${encodeURIComponent(files)}/file?path=${encodeURIComponent(path)}`,
    onClick: (e) => { e.preventDefault(); openCardFile(files, path); } }, label) : undefined;
  return h('div', { className: 'card-text markdown' }, renderMarkdown(h, text, { cardLink, breaks: true, diagram, fileLink }));
}

export const isImage = (t) => /^image\/(png|jpeg|gif|webp)$/.test(t);
// An agent's URL is used only when it is https: a javascript: or data: link must never reach an href.
export const fileUrl = (f) => (f.id ? `${BASE}v1/attachments/${encodeURIComponent(f.id)}` : /^https:\/\//i.test(String(f.url || '')) ? f.url : 'about:blank');
export const sizeText = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// One attached file, rendered by its type: Markdown, CSV and JSON in place, PDF in a frame, anything else behind its name.
export function FileView({ file }) {
  const [text, setText] = React.useState(null);
  const textual = /^(text\/(markdown|plain|csv)|application\/json)$/.test(file.type);
  React.useEffect(() => {
    if (!textual) return;
    fetch(fileUrl(file)).then((r) => r.text()).then(setText, () => setText(''));
  }, [file.id, file.url]);
  // The name opens the file in a tab. The inbox shows a type the browser renders, sandboxed, and downloads the rest.
  const download = h('a', { className: 'file-name', href: fileUrl(file), target: '_blank', rel: 'noopener' }, file.name);
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
  const dark = isDark();
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
      if (e.data.yourAttention === 'session') { if (typeof e.data.href === 'string' && SESSION_LINK.test(e.data.href)) openSessionLink(e.data.href, ref.current); return; }
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
  const steps = changeSteps(card);
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

// The usage counts of this inbox: GET /v1/telemetry, and PUT to change them. Null where the inbox sends none.
export function useTelemetry(signedIn) {
  const [t, setT] = React.useState(null);
  React.useEffect(() => {
    if (signedIn) fetch(`${BASE}v1/telemetry`).then((r) => (r.ok ? r.json() : null)).then(setT, () => setT(null));
  }, [signedIn]);
  // The switch moves at once. The inbox's answer then replaces the guess, and a failed change puts the old setting back.
  const change = (body) => {
    const before = t;
    setT((x) => x && { ...x, ...body, notice: false });
    return fetch(`${BASE}v1/telemetry`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-your-attention': '1' }, body: J(body) })
      .then((r) => (r.ok ? r.json() : null)).then((next) => setT(next || before), () => setT(before));
  };
  return [t, change];
}

const WHAT_COUNTS = 'how many cards were posted and answered, pairing requests, page opens, and how many agents, agent processes and tokens connected';

// Shown until the person picks. On a laptop it offers the counts, which stay off unless they say yes.
// On the hosted service it says once that the counts are always on.
export function UsageNotice({ telemetry: t, onChange }) {
  if (!t || !t.notice) return null;
  const report = h('details', null, h('summary', null, 'The next report'), h('pre', null, J(t.next, null, 2)));
  if (t.alwaysOn) {
    return h('section', { className: 'usage-notice', 'aria-label': 'Usage counts' },
      h('p', null, `This hosted inbox always sends the operator of this service, once a day, ${WHAT_COUNTS}, with an id made from the invite code that created it. There is no off switch. It never sends card text, answers, agent names or addresses.`),
      report,
      h('div', { className: 'usage-actions' }, h('button', { type: 'button', className: 'btn', onClick: () => onChange({ notified: true }) }, 'OK')));
  }
  return h('section', { className: 'usage-notice', 'aria-label': 'Usage counts' },
    h('p', null, `Usage counts are off. If you turn them on, this inbox sends the Your Attention maintainers one anonymous report a day: ${WHAT_COUNTS}, with a random install id. It never sends card text, answers, agent names, paths, host names, addresses or anything else that says who you are.`),
    report,
    h('div', { className: 'usage-actions' },
      h('button', { type: 'button', className: 'btn', onClick: () => onChange({ enabled: true }) }, 'Turn usage counts on'),
      h('button', { type: 'button', className: 'btn', onClick: () => onChange({ notified: true }) }, 'Keep them off')));
}

// The setting, after the person has seen the notice. A hosted inbox shows that the counts are always on.
export function UsageToggle({ telemetry: t, onChange }) {
  if (!t || t.notice) return null;
  if (t.alwaysOn) return h('p', { className: 'notify usage-toggle', title: `Once a day, this hosted inbox sends the operator of this service ${WHAT_COUNTS}. Never card text or answers.` }, 'Usage counts: always on');
  const tip = t.blocked ? `This inbox sends nothing: ${t.blocked}` : `Once a day, send the maintainers an anonymous report: ${WHAT_COUNTS}. Never card text or answers.`;
  return h('label', { className: 'notify usage-toggle', title: tip },
    h('input', { type: 'checkbox', role: 'switch', checked: t.enabled && !t.blocked, disabled: !!t.blocked, onChange: (e) => onChange({ enabled: e.target.checked }) }), 'Send anonymous usage counts');
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
    h(BarIconButton, { className: 'phone', label: 'Open this inbox on your phone', onClick: () => setOpen(true) },
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

/** The inbox's own words for a failed request, so a dialog says why it did not happen. */
const bodyError = (r) => r.json().then(
  (d) => Promise.reject(new Error(d.error || `The inbox answered ${r.status}.`)),
  () => Promise.reject(new Error(`The inbox answered ${r.status}.`)));

/** A top-bar button that shows an icon, named for a screen reader and on hover. */
function BarIconButton({ className, label, onClick, children }) {
  return h('button', { type: 'button', className, onClick, 'aria-label': label, title: label }, children);
}

/** A browser, phone or paired machine that holds a key to this inbox, and a way to sign one out. */
export function DevicesLink() {
  const [open, setOpen] = React.useState(false);
  const [tokens, setTokens] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [confirming, setConfirming] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const ref = React.useRef(null);
  const load = () => api(`${BASE}v1/tokens`)
    .then((r) => (r.ok ? r.json() : bodyError(r)))
    .then((list) => { setTokens(list); setError(null); }, (e) => setError(e.message || 'The list did not load.'));
  React.useEffect(() => {
    if (!open) return;
    if (ref.current && !ref.current.open) ref.current.showModal();
    load();
  }, [open]);
  const close = () => { ref.current?.close(); setOpen(false); setTokens(null); setError(null); setConfirming(null); };
  // A write that uses the cookie carries the header a cross-site form cannot set, as every page write does.
  const revoke = (id) => {
    setBusy(id);
    fetch(`${BASE}v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-your-attention': '1' } })
      .then((r) => (r.ok ? null : bodyError(r)))
      .then(() => { setConfirming(null); return load(); }, (e) => setError(e.message || 'That device did not sign out.'))
      .finally(() => setBusy(null));
  };
  const day = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const role = (t) => (t.role === 'owner' ? 'signs in' : t.role === 'agent' ? 'posts cards' : 'checks cards');
  return h(React.Fragment, null,
    h(BarIconButton, { className: 'devices-open', label: 'Devices signed in to this inbox', onClick: () => setOpen(true) },
      h('svg', { viewBox: '0 0 16 16', width: 22, height: 22, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
        h('circle', { cx: 5.5, cy: 8, r: 2.75 }),
        h('path', { d: 'M8.25 8H14 M12 8v2.5 M10 8v2', strokeLinecap: 'round' }))),
    open && h('dialog', { ref, className: 'qr-dialog devices-dialog', onClose: close, onClick: (e) => { if (e.target === ref.current) close(); }, 'aria-labelledby': 'devices-title' },
      h('h2', { id: 'devices-title' }, 'Devices signed in to this inbox'),
      h('p', null, 'Each browser, phone and machine holds its own key. Signing a device out ends that key, and the others keep working.'),
      error && h('p', { className: 'note warn', role: 'alert' }, error),
      !tokens && !error && h('p', { className: 'muted' }, 'Reading the list…'),
      tokens && !tokens.length && h('p', { className: 'muted' }, 'This inbox lists no device.'),
      tokens && tokens.length > 0 && h('ul', { className: 'devices' }, tokens.map((t) => h('li', { key: t.id, className: 'device' },
        h('div', { className: 'device-what' },
          h('span', { className: 'device-name' }, t.name),
          h('span', { className: 'device-facts' }, `${role(t)} · since ${day(t.createdAt)}${t.pinExempt ? ' · skips the PIN' : ''}`)),
        confirming === t.id
          ? h('div', { className: 'device-actions' },
            h('span', { className: 'note warn' }, 'It loses its key and signs in again with a link.'),
            h('button', { type: 'button', className: 'btn', onClick: () => setConfirming(null) }, 'Keep it'),
            h('button', { type: 'button', className: 'btn danger', onClick: () => revoke(t.id), disabled: busy === t.id, autoFocus: true }, busy === t.id ? 'Signing out…' : 'Sign it out'))
          : h('button', { type: 'button', className: 'btn', onClick: () => setConfirming(t.id) }, 'Sign out')))),
      h('div', { className: 'qr-actions' }, h('button', { type: 'button', className: 'btn primary', onClick: close, autoFocus: confirming === null }, 'Close'))));
}
