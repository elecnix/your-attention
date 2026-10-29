// The card on screen, drawn as the page draws it: its meta line, where it comes from, the agent's replies, your
// answer, the title, the text as Markdown, the recommendation, the files, what changed, the form, and the receipt.
// Each interactive part is a Tab stop. Secret, broadcast and HTML cards get forms in OpenUI Lang too, so one
// renderer draws every card.
import { answerValues, cardSource, changeSteps, describe, formValues } from '../../web/answers.js';
import { cardAge } from '../../web/age.js';
import { CLOSED_LABEL, STATE_LABEL, agentName, presenceOf, type InboxState, type Queue } from '../../web/queue.js';
import type { CardSummary } from '../core/summary.ts';
import type { Answer, Attachment, Card } from '../core/types.ts';
import { BodyRenderer, FormStore, parse, type Action, type BodyContext, type Widget } from './body.ts';
import { Doc, type Span } from './doc.ts';
import type { KeyEvent } from './input.ts';
import { codeBlock, linkTarget, markdown, table, type MdContext } from './md.ts';
import type { Style } from './screen.ts';
import { sanitize, textWidth } from './text.ts';
import type { Theme } from './theme.ts';

const J = JSON.stringify;

/** What the card view asks of the client around it. */
export interface CardViewHost {
  theme: Theme;
  /** The card's address on the page. */
  address(id: string): string;
  /** A button or link: the client decides what it does. */
  act(view: CardView, action: Action | { kind: 'open'; target: string } | { kind: 'api'; path: string }): void;
  /** The text of an attached file, once the client has fetched it, for the file types the page shows in place. */
  fileText(file: Attachment): string | undefined;
  now(): number;
}

/** OpenUI Lang for the cards the page draws with its own components: secret, broadcast and HTML cards. */
export function terminalSource(c: Card, cards: CardSummary[]): string {
  const buttons = (list: [string, string, string][]) => `b = Buttons([${list.map(([label, msg, variant]) => `Button(${J(label)}, @ToAssistant(${J(msg)}), ${J(variant)})`).join(', ')}], "row")`;
  if (c.kind === 'secret' && c.secret) {
    return [
      'root = Card([f])',
      'f = Form("secret", b, [fv, fc])',
      `fv = FormControl(${J(c.secret.name)}, Input("value", "", "password"))`,
      'fc = FormControl("Comment", TextArea("comment", "Anything to add?", 2))',
      buttons([['Send sealed', 'send sealed', 'primary'], ['Decline', 'decline', 'secondary'], ['Skip for now', 'skip', 'secondary']]),
    ].join('\n');
  }
  if (c.broadcast && !c.closed) {
    const agents = c.broadcast.agents;
    return [
      'root = Card([t, f])',
      `t = CodeBlock("text", ${J(c.broadcast.text)})`,
      `f = Form("broadcast", b, [${agents.length ? 'fa' : ''}])`,
      ...(agents.length ? [`fa = FormControl("Agents", CheckBoxGroup("agents", [${agents.map((a) => `CheckBoxItem(${J(agentName(a, cards))}, "", ${J(a)}, true)`).join(', ')}]))`] : []),
      buttons([['Approve and send', 'approve', 'primary'], ['Reject', 'reject', 'secondary']]),
    ].join('\n');
  }
  if (c.html !== undefined) {
    return [
      'root = Card([f])',
      'f = Form("html", b, [fc])',
      'fc = FormControl("Comment", TextArea("comment", "Anything to add?", 3))',
      buttons([['Send answer', 'send answer', 'primary'], ['Skip for now', 'skip', 'secondary']]),
    ].join('\n');
  }
  return cardSource(c);
}

const time = (t: number): string => new Date(t).toLocaleTimeString();
const sizeText = (n?: number): string => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const TEXT_FILE = /^(text\/(markdown|plain|csv)|application\/json)$/;

export class CardView {
  /** The whole card, from GET /v1/cards/<id>, with its answer and the card it follows. */
  card: Card;
  saved: Answer | undefined;
  earlier: { card: Card; answer?: Answer | undefined } | undefined;
  readonly host: CardViewHost;
  readonly store = new FormStore();
  readonly ui = new Map<string, unknown>();
  readonly errors = new Map<string, string>();
  focus: string | undefined;
  widgets = new Map<string, Widget>();
  doc: Doc = new Doc(40);
  /** A line the view shows above the form after an action, such as an error from the inbox. */
  notice: { text: string; style: 'warn' | 'ok' } | undefined;
  private renderer: BodyRenderer | undefined;

  constructor(card: Card, host: CardViewHost) {
    this.card = card;
    this.host = host;
  }

  /** The values and comment the page would send for what the person filled in. */
  answer(): { values: Record<string, unknown>; comment: string } {
    const { values, comment } = formValues(this.store.data);
    return { values: answerValues(this.card, values), comment };
  }

  /** The Tab stops, in order. */
  stops(): string[] {
    return this.doc.stops.map((s) => s.id).filter((id) => this.widgets.has(id));
  }

  /** Move the focus to the next or previous stop. False at either end, so the client can move to the list. */
  move(dir: 1 | -1, wrap = false): boolean {
    const ids = this.stops();
    if (!ids.length) return false;
    const i = this.focus ? ids.indexOf(this.focus) : -1;
    const j = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : i + dir;
    if (j < 0 || j >= ids.length) {
      if (!wrap) return false;
      this.focus = ids[(j + ids.length) % ids.length];
      return true;
    }
    this.focus = ids[j];
    return true;
  }

  /** The first field of the card's form, where the person starts to answer. */
  focusFirstField(): void {
    const ids = this.stops();
    this.focus = ids.find((id) => id.startsWith('field:')) ?? ids.find((id) => id.startsWith('button:')) ?? ids[0];
  }

  focused(): Widget | undefined {
    return this.focus ? this.widgets.get(this.focus) : undefined;
  }

  key(ev: KeyEvent): boolean {
    return this.focused()?.key?.(ev) ?? false;
  }

  paste(text: string): boolean {
    const w = this.focused();
    if (!w?.paste) return false;
    w.paste(text);
    return true;
  }

  /** A click on a target the last drawing placed. */
  click(target: string, row: number, col: number): void {
    const [id, part] = target.split('#') as [string, string | undefined];
    // A field id has a slash and can hold #, so look for the longest widget id the target starts with.
    const widget = this.widgets.get(target) ?? [...this.widgets.values()].filter((w) => target.startsWith(`${w.id}#`)).sort((a, b) => b.id.length - a.id.length)[0] ?? this.widgets.get(id);
    if (widget) {
      this.focus = widget.id;
      widget.click?.(widget.id === target ? undefined : target.slice(widget.id.length + 1) || part, row, col);
      return;
    }
    if (/^(url|session|card):/.test(target)) {
      this.focus = target;
      this.host.act(this, { kind: 'open', target });
    }
  }

  /** Draw the card at a width. Builds the Tab stops and the click targets as it goes. */
  build(width: number, s: InboxState, q: Queue): Doc {
    const card = this.card;
    const theme = this.host.theme;
    const { s: st, g } = theme;
    const doc = new Doc(width);
    this.widgets = new Map();
    // Each link with the line its paragraph starts on, so Tab scrolls to the link.
    const links: { t: string; line: number }[] = [];
    const md: MdContext = {
      theme,
      cardTitle: (id) => q.byId[id]?.title,
      focused: this.focus,
      onLink: (t) => { if (!links.some((l) => l.t === t)) links.push({ t, line: doc.lines.length }); },
    };
    // A link is a Tab stop too, so the keyboard reaches every session link.
    const linkStops = () => {
      for (const { t, line } of links.splice(0)) {
        if (this.widgets.has(t)) continue;
        this.widgets.set(t, { id: t, key: (ev) => { if (ev.name === 'enter' || ev.name === 'space') { this.host.act(this, { kind: 'open', target: t }); return true; } return false; }, click: () => this.host.act(this, { kind: 'open', target: t }) });
        const at = Math.min(line, Math.max(0, doc.lines.length - 1));
        doc.stops.push({ id: t, top: at, bottom: at });
      }
    };
    const button = (id: string, label: string, run: () => void, style: Style = {}): Span => {
      this.widgets.set(id, { id, key: (ev) => { if ((ev.name === 'enter' || ev.name === 'space') && !ev.ctrl) { run(); return true; } return false; }, click: run });
      return { text: `[ ${label} ]`, style: { ...style, ...(this.focus === id ? { inverse: true } : {}) }, target: id };
    };
    const stopLine = (ids: string[], spans: Span[]) => {
      for (const id of ids) doc.begin(id);
      doc.para(spans);
      for (const id of ids) doc.end(id);
    };
    const toggle = (id: string, label: string): boolean => {
      const open = this.ui.get(id) === true;
      this.widgets.set(id, { id, key: (ev) => { if (ev.name === 'enter' || ev.name === 'space') { this.ui.set(id, !open); return true; } return false; }, click: () => this.ui.set(id, !open) });
      stopLine([id], [{ text: `${open ? g.open : g.shut} `, style: st.accent, target: id }, { text: label, style: { ...st.link, ...(this.focus === id ? { inverse: true } : {}) }, target: id }]);
      return open;
    };

    // The queue reads the card's summary, which has its reply and answer states.
    const sum = q.byId[card.id];
    const state = sum ? q.st(sum) : 'open';
    const a = this.saved;
    const level = (s.levels ?? []).find((l) => l.id === (sum ? q.levelOf(sum) : card.priority));
    if (state === 'closed' && card.closed) {
      stopLine(['closed:next'], [
        { text: `[${CLOSED_LABEL[card.closed.kind] ?? 'Closed'}] `, style: st.warn },
        { text: `${sanitize(card.closed.outcome)} ` },
        button('closed:next', 'Next card', () => this.host.act(this, { kind: 'assistant', message: 'skip' })),
      ]);
      doc.gap();
    }

    // The meta line: the level with its symbol, the agent's status, a warning state, presence, and the age at the right.
    const meta: Span[] = [{ text: `${g.waiting} ${sanitize(level?.label ?? q.label(sum ? q.levelOf(sum) : card.priority))}`, style: theme.level(level?.color) }];
    if (card.status) meta.push({ text: '  ' }, { text: `[${sanitize(card.status)}]`, style: st.dim });
    if (['in-triage', 'held', 'orphaned'].includes(state)) meta.push({ text: '  ' }, { text: `Warning: ${STATE_LABEL[state]}`, style: st.warn });
    const pres = presenceOf(sum ?? card, s);
    if (pres) meta.push({ text: '  ' }, { text: `${pres[0] === 'on' ? g.read : pres[0] === 'busy' ? g.delivered : g.stored} ${sanitize(pres[1].split(':')[0] ?? '')}`, style: pres[0] === 'on' ? st.ok : st.dim });
    const age = cardAge(this.host.now() - card.createdAt);
    const metaW = meta.reduce((w, x) => w + textWidth(x.text), 0);
    if (metaW + 2 + textWidth(age) <= width) meta.push({ text: ' '.repeat(width - metaW - textWidth(age)) }, { text: age, style: st.dim });
    else meta.push({ text: `  ${age}`, style: st.dim });
    doc.para(meta);

    const tr = card.triage;
    if (tr && tr.state === 'passed' && /did not answer|failed/.test(tr.reason ?? '')) doc.para([{ text: `Note: Triage did not check this card: ${sanitize(tr.reason ?? '')}`, style: st.dim }]);
    if (tr && (tr.state === 'held' || tr.state === 'returned')) {
      const spans: Span[] = [{ text: `Warning: ${sanitize(tr.by ?? 'An extension')} ${tr.state === 'held' ? 'held this card' : 'sent this card back'}: ${sanitize(tr.reason ?? 'no reason given')} `, style: st.warn }];
      if (tr.state === 'held') { spans.push(button('meta:release', 'Release', () => this.host.act(this, { kind: 'api', path: `/v1/cards/${encodeURIComponent(card.id)}/release` }))); stopLine(['meta:release'], spans); } else doc.para(spans);
    }
    if (card.from) doc.para([{ text: `From ${sanitize(card.from)}`, style: st.dim }]);
    const o = card.origin ?? {};
    if (o.harness || o.host || o.herdrWorkspace || o.herdrTab) {
      const where = [o.name, o.harness, o.host, o.cwd].filter(Boolean).map((x) => sanitize(String(x))).join(' · ');
      if (where) doc.para([{ text: where, style: st.dim }]);
      const place = [o.herdrWorkspace && `workspace ${o.herdrWorkspace}`, o.herdrTab && `tab ${o.herdrTab}`].filter(Boolean).join(` ${g.shut} `);
      const spans: Span[] = place ? [{ text: `herdr: ${sanitize(place)} `, style: st.dim }] : [];
      if (o.herdrPane && card.kind !== 'blocked') { spans.push(button('meta:open', 'Open session', () => this.host.act(this, { kind: 'api', path: `/v1/cards/${encodeURIComponent(card.id)}/open` }))); stopLine(['meta:open'], spans); } else if (spans.length) doc.para(spans);
    }
    const followed = card.followedBy ? q.byId[card.followedBy] : undefined;
    if (followed) { const t = `card:${followed.id}`; md.onLink?.(t); doc.para([{ text: 'Followed by ', style: st.dim }, { text: sanitize(followed.title), style: { ...st.link, ...(this.focus === t ? { inverse: true } : {}) }, target: t }]); linkStops(); }
    for (const r of card.replies.slice().reverse()) {
      doc.gap();
      doc.para([{ text: `${g.reply} Agent reply · ${time(r.at)}`, style: st.bold }]);
      doc.para([{ text: sanitize(r.text) }], { first: [{ text: '  ' }] });
    }
    if (a && state !== 'reply') { doc.gap(); doc.para([{ text: 'Your answer: ', style: { ...st.ok, bold: true } }, { text: sanitize(describe(card, a)), style: st.ok }]); }
    if (this.notice) { doc.gap(); doc.para([{ text: sanitize(this.notice.text), style: this.notice.style === 'warn' ? st.error : st.ok }]); }

    doc.gap();
    doc.para([{ text: sanitize(card.title), style: { ...st.title, ...(theme.caps.color ? {} : { underline: true }) } }]);
    if (!card.broadcast && card.text) { doc.gap(); markdown(doc, card.text, md); linkStops(); }
    if (card.recommendation) {
      doc.gap();
      const bar: Span[] = [{ text: `${g.quote} `, style: st.accent }];
      doc.para([{ text: 'Recommendation', style: { ...st.accent, bold: true } }], { first: bar, rest: bar });
      const rec = new Doc(width - 2);
      markdown(rec, card.recommendation, md);
      for (const l of rec.lines) doc.push({ spans: [...bar, ...l.spans] });
      linkStops();
    }
    if (card.attachments?.length) {
      doc.gap();
      for (const f of card.attachments) this.file(doc, f, md);
      linkStops();
    }
    this.changes(doc, toggle);

    doc.gap();
    if (card.html !== undefined) {
      const t = `url:${this.host.address(card.id)}`;
      md.onLink?.(t);
      doc.para([{ text: 'This card brings its own HTML and scripts, which the terminal does not run. Open it in the browser to see it: ', style: st.warn }, { text: this.host.address(card.id), style: { ...st.link, link: this.host.address(card.id), ...(this.focus === t ? { inverse: true } : {}) }, target: t }]);
      linkStops();
      doc.gap();
    }
    const ctx: BodyContext = {
      theme, md, store: this.store, ui: this.ui, errors: this.errors, focused: this.focus, widgets: this.widgets,
      address: this.host.address(card.id),
      onAction: (action) => this.host.act(this, action),
    };
    // A body stored before the inbox checked bodies may not draw whole: the inbox sends what the page draws in its place.
    if (card.bodyFallback) doc.para([{ text: 'Warning: part of this card did not draw, because its body has an error. The source from that error on is at the end of the card.', style: st.warn }]);
    const result = parse(terminalSource(card.bodyFallback ? { ...card, body: card.bodyFallback.body } : card, s.cards));
    if (!result) doc.para([{ text: 'Loading the form…', style: st.dim }]);
    else {
      this.renderer = new BodyRenderer(doc, ctx);
      this.renderer.render(result);
      linkStops();
    }

    if (a) {
      doc.gap();
      const spans: Span[] = [
        { text: `${g.stored} Stored at ${time(a.savedAt)}`, style: st.ok },
        { text: `  ${a.deliveredAt ? g.delivered : g.stored} ${a.deliveredAt ? `Delivered at ${time(a.deliveredAt)}` : 'Not delivered yet: agent offline'}`, style: a.deliveredAt ? st.ok : st.dim },
        { text: `  ${a.readAt ? g.read : g.stored} ${a.readAt ? `Read by the agent at ${time(a.readAt)}` : 'Not read by the agent yet'}`, style: a.readAt ? st.ok : st.dim },
      ];
      if (!a.readAt) {
        spans.push({ text: '  ' }, button('meta:force', a.forcedAt ? `Force-sent at ${time(a.forcedAt)}. Send again` : 'Force-send', () => this.host.act(this, { kind: 'api', path: `/v1/cards/${encodeURIComponent(card.id)}/force` })));
        stopLine(['meta:force'], spans);
      } else doc.para(spans);
    }
    const backlinks = s.cards.filter((c) => c.id !== card.id && (c.links ?? []).includes(card.id));
    if (backlinks.length) {
      doc.gap();
      const spans: Span[] = [{ text: 'Linked from ', style: st.dim }];
      backlinks.forEach((c, i) => { const t = `card:${c.id}`; md.onLink?.(t); if (i) spans.push({ text: ', ' }); spans.push({ text: sanitize(c.title), style: { ...st.link, ...(this.focus === t ? { inverse: true } : {}) }, target: t }); });
      doc.para(spans);
      linkStops();
    }
    const prev = card.follows ? this.earlier?.card : undefined;
    if (prev) {
      doc.gap();
      if (toggle('meta:earlier', 'The card before this one, and your answer')) {
        const t = `card:${prev.id}`;
        md.onLink?.(t);
        doc.para([{ text: sanitize(prev.title), style: { ...st.link, bold: true, ...(this.focus === t ? { inverse: true } : {}) }, target: t }], { first: [{ text: '  ' }] });
        linkStops();
        if (prev.text) doc.para([{ text: sanitize(prev.text) }], { first: [{ text: '  ' }] });
        const before = this.earlier?.answer;
        doc.para([{ text: before ? sanitize(describe(prev, before)) : 'You did not answer it.', style: st.ok }], { first: [{ text: '  ' }] });
      }
    }
    // Keep the focus on a stop that still exists, such as after a revision dropped a field.
    if (this.focus && !this.widgets.has(this.focus)) this.focus = undefined;
    this.doc = doc;
    return doc;
  }

  /** One attached file: its name, type and size, and in place the text of Markdown, CSV, JSON and plain files. */
  private file(doc: Doc, f: Attachment, md: MdContext): void {
    const { s: st, g } = this.host.theme;
    const image = /^image\//.test(f.type);
    const url = f.id ? `${this.host.address(this.card.id)}` : /^https:\/\//i.test(f.url ?? '') ? f.url! : '';
    const t = url ? linkTarget(url) : undefined;
    if (t) md.onLink?.(t);
    const label = image ? `[image] ${sanitize(f.alt || f.name)}` : `[file] ${sanitize(f.name)}`;
    doc.para([
      { text: label, style: { ...(t ? st.link : {}), ...(t && f.url ? { link: f.url } : {}), ...(this.focus === t ? { inverse: true } : {}) }, target: t },
      { text: `  ${[f.type, sizeText(f.size)].filter(Boolean).join(' · ')}`, style: st.dim },
    ]);
    if (!TEXT_FILE.test(f.type)) return;
    const text = this.host.fileText(f);
    if (text === undefined) { doc.para([{ text: `  Loading ${sanitize(f.name)}${g.ellipsis}`, style: st.dim }]); return; }
    const sub = new Doc(doc.width - 2);
    if (f.type === 'text/markdown') markdown(sub, text, md);
    else if (f.type === 'application/json') { let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* shown as it is */ } codeBlock(sub, pretty, [], this.host.theme); }
    else if (f.type === 'text/csv') {
      const rows = text.trim().split(/\r?\n/).slice(0, 200).map((l) => l.split(',').map((c) => [{ text: sanitize(c) }]));
      table(sub, rows, [], this.host.theme);
    } else codeBlock(sub, text, [], this.host.theme);
    for (const l of sub.lines) doc.push({ spans: [{ text: '  ' }, ...l.spans] });
  }

  /** What changed, edit by edit, behind a toggle as the page shows it. */
  private changes(doc: Doc, toggle: (id: string, label: string) => boolean): void {
    const { s: st } = this.host.theme;
    const steps = changeSteps(this.card);
    if (!steps.length) return;
    doc.gap();
    if (!toggle('meta:changes', steps.length === 1 ? 'What changed in the last edit' : `What changed, edit by edit (${steps.length} edits)`)) return;
    for (const step of steps) {
      doc.para([{ text: `Version ${step.version}`, style: st.bold }], { first: [{ text: '  ' }] });
      for (const f of step.fields) {
        doc.para([{ text: f.label, style: st.dim }], { first: [{ text: '  ' }] });
        for (const l of f.removed) doc.para([{ text: `− ${sanitize(l)}`, style: st.warn }], { first: [{ text: '    ' }] });
        for (const l of f.added) doc.para([{ text: `+ ${sanitize(l)}`, style: st.ok }], { first: [{ text: '    ' }] });
      }
    }
  }
}
