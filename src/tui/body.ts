// A card's OpenUI Lang, drawn as terminal widgets. The source is what the page renders (web/answers.js cardSource),
// parsed by OpenUI's own parser with the page's component list (src/adapters/openui-library.ts). Each form field keeps its
// value in a store shaped like the page renderer's, {form: {field: {value}}}, so web/answers.js turns it into the
// same answer the page sends. A component the terminal cannot draw says so, with the card's address in the browser.
import type { ElementNode, ParseResult } from '@openuidev/lang-core';
import { Doc, type Span } from './doc.ts';
import { editKey, editPaste, editRows, cursorPos, indexAt, type EditState } from './edit.ts';
import type { KeyEvent } from './input.ts';
import { codeBlock, diagram, inlineSpans, markdown, table, type MdContext } from './md.ts';
import type { Style } from './screen.ts';
import { sanitize, textWidth } from './text.ts';
import type { Theme } from './theme.ts';

type Lang = typeof import('@openuidev/lang-core');
let lang: Lang | undefined;
let parser: { parse(s: string): ParseResult } | undefined;

/**
 * Load OpenUI's parser with the page's component list, the one the inbox checks bodies against. It takes about 50 ms,
 * so the client starts it at once and draws the list meanwhile.
 */
export async function loadParser(): Promise<void> {
  if (parser) return;
  lang = await import('@openuidev/lang-core');
  const { LIBRARY } = await import('../adapters/openui-library.ts');
  parser = lang.createParser(LIBRARY as Parameters<Lang['createParser']>[0], 'root');
}

export const parserReady = (): boolean => parser !== undefined;

/** Parse OpenUI Lang. Undefined until loadParser() has finished. */
export function parse(source: string): ParseResult | undefined {
  return parser?.parse(source);
}

/** The form fields of one card, in the shape the page's renderer keeps them. */
export class FormStore {
  data: Record<string, Record<string, { value: unknown; componentType?: string }>> = {};

  get(form: string, name: string): unknown {
    return this.data[form]?.[name]?.value;
  }

  has(form: string, name: string): boolean {
    return !!this.data[form] && name in this.data[form];
  }

  set(form: string, name: string, value: unknown, componentType?: string): void {
    this.data[form] = { ...(this.data[form] ?? {}), [name]: componentType ? { value, componentType } : { value } };
  }
}

export type Action =
  | { kind: 'assistant'; message: string }
  | { kind: 'url'; url: string };

/** One Tab stop of the card: what keys, clicks and pastes do there. */
export interface Widget {
  id: string;
  /** Typing goes to this widget, so letters are not shortcuts while it has focus. */
  text?: boolean;
  /** Handle a key. False when the widget does not use it, so the pane can. */
  key?(ev: KeyEvent): boolean;
  /** A click on the widget, at a row and column of the document, and the part of it the click hit. */
  click?(part: string | undefined, row: number, col: number): void;
  paste?(text: string): void;
}

export interface BodyContext {
  theme: Theme;
  md: MdContext;
  store: FormStore;
  /** Per-widget state that is not an answer value: cursors, the highlighted item, what is open. */
  ui: Map<string, unknown>;
  /** Field errors from rules, by form and field. */
  errors: Map<string, string>;
  focused: string | undefined;
  widgets: Map<string, Widget>;
  /** A button was pressed. `validated` is false when a rule stopped it. */
  onAction(action: Action, form: string | undefined): void;
  /** The address of this card on the page, for what the terminal cannot draw. */
  address: string;
}

/** A field with rules registers here, so a primary button can check its form before it sends. */
interface Rule { key: string; rules: unknown; get(): unknown }

/** A value from the parser: a literal, or an expression the terminal reads when it is only a literal. */
function lit(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(lit);
  const n = v as { k?: string; v?: unknown; els?: unknown[]; entries?: [string, unknown][]; type?: string };
  if (n.type === 'element') return v;
  if (n.k === 'Str' || n.k === 'Num' || n.k === 'Bool') return n.v;
  if (n.k === 'Null') return null;
  if (n.k === 'Arr') return (n.els ?? []).map(lit);
  if (n.k === 'Obj') return Object.fromEntries((n.entries ?? []).map(([k, x]) => [k, lit(x)]));
  if (n.k) return undefined;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lit(x)]));
}

const str = (v: unknown): string => {
  const x = lit(v);
  return x === undefined || x === null ? '' : typeof x === 'object' ? '' : String(x);
};
const isEl = (v: unknown): v is ElementNode => !!v && typeof v === 'object' && (v as { type?: string }).type === 'element';
const els = (v: unknown): ElementNode[] => (Array.isArray(v) ? v.flat(Infinity).filter(isEl) : isEl(v) ? [v] : []);

/** What a button does: its @ToAssistant message, its @OpenUrl address, or, with no action, its label as the message. */
export function buttonAction(action: unknown, label: string): Action {
  const steps: unknown[] = [];
  const collect = (a: unknown) => {
    if (!a || typeof a !== 'object') return;
    const n = a as { k?: string; name?: string; args?: unknown[]; els?: unknown[]; steps?: unknown[] };
    if (n.k === 'Comp' && (n.name === 'Action' || n.name === 'Steps')) { (n.args ?? []).forEach(collect); return; }
    if (n.k === 'Arr') { (n.els ?? []).forEach(collect); return; }
    if (Array.isArray(n.steps)) { n.steps.forEach(collect); return; }
    steps.push(a);
  };
  collect(action);
  for (const s of steps) {
    const n = s as { k?: string; name?: string; args?: unknown[]; mappedProps?: Record<string, unknown>; type?: string; message?: string; url?: string };
    const name = n.name ?? n.type;
    if (name === 'ToAssistant' || name === 'to_assistant') return { kind: 'assistant', message: str(n.mappedProps?.['message'] ?? n.args?.[0] ?? n.message) || label };
    if (name === 'OpenUrl' || name === 'open_url') return { kind: 'url', url: str(n.mappedProps?.['url'] ?? n.args?.[0] ?? n.url) };
  }
  return { kind: 'assistant', message: label };
}

/** The state of a single- or multiple-choice field, as OpenUI's selection helpers keep it. */
function normalizeSelection(type: string, stored: unknown, def: unknown): string[] {
  const strings = (v: unknown[]) => v.filter((x): x is string => typeof x === 'string');
  if (type === 'single') {
    const one = typeof stored === 'string' ? stored : Array.isArray(stored) && typeof stored[0] === 'string' ? stored[0] : typeof def === 'string' ? def : Array.isArray(def) && typeof def[0] === 'string' ? def[0] : '';
    return one ? [one] : [];
  }
  if (Array.isArray(stored)) return strings(stored);
  if (typeof stored === 'string') return stored ? [stored] : [];
  if (Array.isArray(def)) return strings(def);
  return typeof def === 'string' && def ? [def] : [];
}
function storedDefault(type: string, def: unknown): unknown {
  if (type === 'single') return typeof def === 'string' ? def || undefined : Array.isArray(def) && typeof def[0] === 'string' ? def[0] || undefined : undefined;
  if (Array.isArray(def)) return def.filter((x) => typeof x === 'string');
  return typeof def === 'string' ? (def ? [def] : []) : undefined;
}

export class BodyRenderer {
  private doc: Doc;
  private ctx: BodyContext;
  private rules = new Map<string, Rule[]>();
  private counter = new Map<string, number>();
  private indent = 0;

  constructor(doc: Doc, ctx: BodyContext) {
    this.doc = doc;
    this.ctx = ctx;
  }

  private get width(): number {
    return Math.max(4, this.doc.width - this.indent);
  }

  private pad(): Span[] {
    return this.indent ? [{ text: ' '.repeat(this.indent) }] : [];
  }

  /** A stable id for the nth widget of a kind, in the order the card draws them. */
  private nextId(kind: string, name = ''): string {
    const key = `${kind}:${name}`;
    const n = this.counter.get(key) ?? 0;
    this.counter.set(key, n + 1);
    return n ? `${key}#${n}` : key;
  }

  /** Draw a parsed card. */
  render(result: ParseResult): void {
    if (!result.root) {
      this.fallback('body', result.meta.errors[0]?.message);
      return;
    }
    this.node(result.root, undefined);
  }

  private node(n: ElementNode, form: string | undefined): void {
    const p = n.props;
    const { s, g } = this.ctx.theme;
    const doc = this.doc;
    switch (n.typeName) {
      case 'Card':
      case 'Carousel':
        els(p['children']).forEach((c, i) => { if (i) doc.gap(); this.node(c, form); });
        return;
      case 'CardHeader':
        if (str(p['title'])) doc.para(inlineSpans(str(p['title']), this.ctx.md, s.title), { first: this.pad() });
        if (str(p['subtitle'])) doc.para(inlineSpans(str(p['subtitle']), this.ctx.md, s.dim), { first: this.pad() });
        return;
      case 'TextContent':
        markdown(doc, str(p['text']), this.ctx.md, this.indent);
        return;
      case 'MarkDownRenderer':
        markdown(doc, str(p['textMarkdown']), this.ctx.md, this.indent);
        return;
      case 'Text':
      case 'BoldText':
        doc.para(inlineSpans([str(p['value']), str(p['subtext'])].filter(Boolean).join(' '), this.ctx.md, n.typeName === 'BoldText' ? s.bold : {}), { first: this.pad() });
        return;
      case 'Label':
        doc.para(inlineSpans(str(p['text']), this.ctx.md, s.bold), { first: this.pad() });
        return;
      case 'InlineHeader':
        doc.para(inlineSpans(str(p['heading']), this.ctx.md, s.heading), { first: this.pad() });
        if (str(p['description'])) doc.para(inlineSpans(str(p['description']), this.ctx.md, s.dim), { first: this.pad() });
        return;
      case 'Callout':
      case 'TextCallout': {
        const variant = str(p['variant']);
        const label = /warn/.test(variant) ? 'Warning' : /error|danger/.test(variant) ? 'Error' : /success/.test(variant) ? 'Done' : 'Note';
        const bar: Span[] = [...this.pad(), { text: `${g.quote} `, style: label === 'Note' ? s.accent : label === 'Done' ? s.ok : s.warn }];
        doc.para([{ text: `${label}: `, style: { ...(label === 'Note' ? s.accent : label === 'Done' ? s.ok : s.warn), bold: true } }, ...inlineSpans(str(p['title']), this.ctx.md, s.bold)], { first: bar, rest: bar });
        if (str(p['description'])) doc.para(inlineSpans(str(p['description']), this.ctx.md), { first: bar, rest: bar });
        return;
      }
      case 'Mermaid':
        diagram(doc, str(p['source']), this.pad(), this.ctx.theme);
        return;
      case 'CodeBlock':
        codeBlock(doc, str(p['codeString']), this.pad(), this.ctx.theme);
        return;
      case 'Separator':
        doc.push({ spans: [...this.pad(), { text: g.rule.repeat(Math.max(1, this.width)), style: s.dim }] });
        return;
      case 'Table': {
        const cols = els(p['columns']);
        const data = cols.map((c) => (Array.isArray(lit(c.props['data'])) ? (lit(c.props['data']) as unknown[]) : []));
        const height = Math.max(0, ...data.map((d) => d.length));
        const rows = [cols.map((c) => inlineSpans(str(c.props['label']), this.ctx.md, s.bold))];
        for (let r = 0; r < height; r++) rows.push(data.map((d) => inlineSpans(str(d[r]), this.ctx.md)));
        table(doc, rows, this.pad(), this.ctx.theme);
        return;
      }
      case 'TagBlock':
        doc.para(els(p['tags']).flatMap((t, i) => [...(i ? [{ text: ' ' }] : []), { text: `[${sanitize(str(t.props['text']))}]`, style: s.dim }]), { first: this.pad() });
        return;
      case 'Tag':
        doc.para([{ text: `[${sanitize(str(p['text']))}]`, style: s.dim }], { first: this.pad() });
        return;
      case 'Image':
      case 'ImageBlock':
        this.image(str(p['src']), str(p['alt']));
        return;
      case 'ImageGallery':
        for (const im of (lit(p['images']) as { src?: string; alt?: string }[] | undefined) ?? []) this.image(str(im?.src), str(im?.alt));
        return;
      case 'Steps':
        els(p['items']).forEach((it, i) => {
          doc.para(inlineSpans(str(it.props['title']), this.ctx.md, s.bold), { first: [...this.pad(), { text: `${i + 1}. `, style: s.dim }] });
          if (str(it.props['details'])) this.nested(3, () => markdown(doc, str(it.props['details']), this.ctx.md, this.indent));
        });
        return;
      case 'ListBlock':
        for (const it of els(p['items'])) {
          doc.para([...inlineSpans(str(it.props['title']), this.ctx.md, s.bold), ...(str(it.props['subtitle']) ? [{ text: ' ' }, ...inlineSpans(str(it.props['subtitle']), this.ctx.md, s.dim)] : [])], { first: [...this.pad(), { text: `${g.bullet} `, style: s.dim }] });
        }
        return;
      case 'FollowUpBlock':
        for (const it of els(p['items'])) doc.para(inlineSpans(str(it.props['text']), this.ctx.md), { first: [...this.pad(), { text: `${g.bullet} `, style: s.dim }] });
        return;
      case 'Tabs':
      case 'Accordion':
      case 'SectionBlock':
        // Every section shows, each under its own heading: a terminal has room to scroll, and nothing hides a field.
        els(p['items'] ?? p['sections']).forEach((it, i) => {
          if (i) doc.gap();
          doc.para(inlineSpans(str(it.props['trigger']), this.ctx.md, s.heading), { first: this.pad() });
          els(it.props['content']).forEach((c) => this.node(c, form));
        });
        return;
      case 'Form': {
        const name = str(p['name']);
        const fields = els(p['fields']);
        fields.forEach((f, i) => { if (i) doc.gap(); this.node(f, name); });
        const buttons = els(p['buttons']);
        if (buttons.some((b) => els(b.props['buttons']).length)) { doc.gap(); buttons.forEach((b) => this.node(b, name)); }
        return;
      }
      case 'FormControl': {
        const input = els(p['input'])[0];
        const label = str(p['label']);
        if (label && input?.typeName !== 'CheckWithText') doc.para(inlineSpans(label, this.ctx.md, s.bold), { first: this.pad() });
        if (input) this.node(input, form);
        if (str(p['hint'])) doc.para(inlineSpans(str(p['hint']), this.ctx.md, s.dim), { first: this.pad() });
        return;
      }
      case 'Input':
      case 'TextArea':
        this.textField(n, form ?? '', n.typeName === 'TextArea');
        return;
      case 'DatePicker':
        if (str(p['mode']) === 'range') { this.fallback('DatePicker'); return; }
        this.textField(n, form ?? '', false, 'date');
        return;
      case 'RadioGroup':
      case 'CheckBoxGroup':
      case 'SwitchGroup':
      case 'OptionCards':
        this.choices(n, form ?? '');
        return;
      case 'Select':
        this.select(n, form ?? '');
        return;
      case 'Slider':
        this.slider(n, form ?? '');
        return;
      case 'CheckWithText':
        this.checkWithText(n, form);
        return;
      case 'Buttons':
        this.buttons(els(p['buttons']), form);
        return;
      case 'Button':
        this.buttons([n], form);
        return;
      default:
        this.fallback(n.typeName);
    }
  }

  private nested(by: number, f: () => void): void {
    this.indent += by;
    try { f(); } finally { this.indent -= by; }
  }

  private image(src: string, alt: string): void {
    const { s } = this.ctx.theme;
    const https = /^https:\/\//i.test(src);
    const target = https ? `url:${src}` : undefined;
    if (target) this.ctx.md.onLink?.(target);
    this.doc.para([{ text: '[image] ', style: s.dim }, { text: sanitize(alt || 'an image'), style: https ? { ...s.link, link: src, ...(this.ctx.md.focused === target ? { inverse: true } : {}) } : {}, target }], { first: this.pad() });
  }

  /** A line that says the terminal cannot draw part of the card, and where the page shows it. */
  fallback(what: string, why?: string): void {
    const { s } = this.ctx.theme;
    const t = `url:${this.ctx.address}`;
    this.ctx.md.onLink?.(t);
    this.doc.para([
      { text: `This card has ${what === 'body' ? 'a body' : `a ${what}`} that the terminal cannot show${why ? ` (${sanitize(why)})` : ''}. Open the card in the browser: `, style: s.warn },
      { text: this.ctx.address, style: { ...s.link, link: this.ctx.address, ...(this.ctx.md.focused === t ? { inverse: true } : {}) }, target: t },
    ], { first: this.pad() });
  }

  private register(form: string, name: string, rules: unknown): void {
    if (!rules || typeof rules !== 'object' || !Object.keys(rules).length) return;
    const list = this.rules.get(form) ?? [];
    list.push({ key: `${form}/${name}`, rules, get: () => this.ctx.store.get(form, name) });
    this.rules.set(form, list);
  }

  /** Check a form's fields against their rules, as a primary button does before it fires. True when every field passes. */
  validate(form: string | undefined): boolean {
    if (!lang || form === undefined) return true;
    let ok = true;
    for (const r of this.rules.get(form) ?? []) {
      const error = lang.validate(r.get(), lang.parseStructuredRules(r.rules));
      if (error) { this.ctx.errors.set(r.key, error); ok = false; } else this.ctx.errors.delete(r.key);
    }
    return ok;
  }

  private error(form: string, name: string): void {
    const e = this.ctx.errors.get(`${form}/${name}`);
    if (e) this.doc.para([{ text: `Error: ${sanitize(e)}`, style: this.ctx.theme.s.error }], { first: this.pad() });
  }

  private box(focused: boolean): { tl: string; tr: string; bl: string; br: string; h: string; v: string } {
    return focused ? this.ctx.theme.g.focusBox : this.ctx.theme.g.box;
  }

  private textField(n: ElementNode, form: string, multiline: boolean, kind?: 'date'): void {
    const p = n.props;
    const name = str(p['name']);
    const id = this.nextId('field', `${form}/${name}`);
    const { s } = this.ctx.theme;
    const store = this.ctx.store;
    const password = str(p['type']) === 'password';
    const initial = str(p['value']);
    const uiKey = `${id}:text`;
    // A date field keeps what the person types, and stores the date once it reads as one, as the page's picker does.
    const shown = (): string => (kind === 'date' ? ((this.ctx.ui.get(uiKey) as string | undefined) ?? initial) : String(store.has(form, name) ? store.get(form, name) ?? '' : initial));
    const value = shown();
    const cursor = Math.min(value.length, (this.ctx.ui.get(`${id}:cur`) as number | undefined) ?? value.length);
    const focused = this.ctx.focused === id;
    const inner = Math.max(4, this.width - 4);
    const b = this.box(focused);
    const save = (next: EditState) => {
      this.ctx.ui.set(`${id}:cur`, next.cursor);
      this.ctx.errors.delete(`${form}/${name}`);
      if (kind === 'date') {
        this.ctx.ui.set(uiKey, next.value);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(next.value.trim());
        // The picker stores the day at local midnight. A day the calendar does not have, such as February 30, is not a date.
        const day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
        // The Date constructor reads years 0 to 99 as 1900 to 1999, so the year is set again on its own.
        day?.setFullYear(Number(m?.[1]));
        if (day && day.getFullYear() === Number(m![1]) && day.getMonth() === Number(m![2]) - 1 && day.getDate() === Number(m![3])) store.set(form, name, day.toISOString());
        else if (store.has(form, name)) store.set(form, name, undefined);
      } else store.set(form, name, next.value);
    };
    this.ctx.widgets.set(id, {
      id,
      text: true,
      key: (ev) => {
        const next = editKey({ value: shown(), cursor: Math.min(shown().length, (this.ctx.ui.get(`${id}:cur`) as number | undefined) ?? shown().length) }, ev, { multiline, width: inner });
        if (!next) return false;
        save(next);
        return true;
      },
      paste: (text) => save(editPaste({ value: shown(), cursor: (this.ctx.ui.get(`${id}:cur`) as number | undefined) ?? shown().length }, sanitize(text.replace(/\r\n?/g, '\n')).replace(/\t/g, '  '), multiline)),
      click: (_part, row, col) => {
        const top = (this.ctx.ui.get(`${id}:top`) as number | undefined) ?? row;
        this.ctx.ui.set(`${id}:cur`, indexAt(password ? '•'.repeat(shown().length) : shown(), inner, row - top, col - this.indent - 2));
      },
    });
    const display = password ? '•'.repeat(value.length) : value;
    const rows = editRows(display, inner);
    const minRows = multiline ? Math.max(1, Number(lit(p['rows'])) || 3) : 1;
    const pos = cursorPos({ value: display, cursor: password ? cursor : cursor }, inner);
    const doc = this.doc;
    doc.begin(id);
    doc.push({ spans: [...this.pad(), { text: `${b.tl}${b.h.repeat(inner + 2)}${b.tr}`, style: focused ? s.focus : s.dim, target: id }] });
    this.ctx.ui.set(`${id}:top`, doc.lines.length);
    const count = Math.max(minRows, rows.length);
    for (let r = 0; r < count; r++) {
      const row = rows[r];
      const text = row?.text ?? '';
      const spans: Span[] = [...this.pad(), { text: `${b.v} `, style: focused ? s.focus : s.dim, target: id }];
      if (!value && r === 0 && str(p['placeholder'])) {
        const ph = sanitize(str(p['placeholder']));
        if (focused) spans.push({ text: ph.slice(0, 1) || ' ', style: { ...s.dim, inverse: true }, target: id }, { text: ph.slice(1), style: s.dim, target: id });
        else spans.push({ text: ph, style: s.dim, target: id });
        spans.push({ text: ' '.repeat(Math.max(0, inner - textWidth(ph))), target: id });
      } else if (focused && r === pos.row) {
        // The cursor is the cell in inverse video.
        const before = row ? sliceCols(text, 0, pos.col) : '';
        const at = sliceCols(text, pos.col, pos.col + 1) || ' ';
        const after = sliceCols(text, pos.col + textWidth(at), inner);
        spans.push({ text: before, target: id }, { text: at, style: { inverse: true }, target: id }, { text: after, target: id });
        spans.push({ text: ' '.repeat(Math.max(0, inner - textWidth(before) - textWidth(at) - textWidth(after))), target: id });
      } else {
        spans.push({ text, target: id }, { text: ' '.repeat(Math.max(0, inner - textWidth(text))), target: id });
      }
      spans.push({ text: ` ${b.v}`, style: focused ? s.focus : s.dim, target: id });
      doc.push({ spans });
    }
    doc.push({ spans: [...this.pad(), { text: `${b.bl}${b.h.repeat(inner + 2)}${b.br}`, style: focused ? s.focus : s.dim, target: id }] });
    doc.end(id);
    this.register(form, name, lit(p['rules']));
    this.error(form, name);
  }

  private choices(n: ElementNode, form: string): void {
    const p = n.props;
    const name = str(p['name']);
    const kind = n.typeName;
    const id = this.nextId('field', `${form}/${name}`);
    const store = this.ctx.store;
    const { s, g } = this.ctx.theme;
    type Item = { value: string; label: string; description: string; checked?: boolean };
    const raw = els(p['items']);
    const items: Item[] = raw.map((it) => {
      const q = it.props;
      if (kind === 'RadioGroup') return { value: str(q['value']), label: str(q['label']), description: str(q['description']) };
      if (kind === 'OptionCards') return { value: str(q['value']), label: str(q['title']), description: str(q['subtitle']) };
      return { value: str(q['name']), label: str(q['label']), description: str(q['description']), checked: lit(q['defaultChecked']) === true };
    }).filter((it) => kind !== 'OptionCards' || it.value);
    if (!items.length) return;
    const type = kind === 'OptionCards' ? (str(p['type']) || 'single') : kind === 'RadioGroup' ? 'single' : 'multiple';
    const def = lit(p['defaultValue']);
    // OptionCards writes its default into the form when it first renders, as OpenUI's does; the others never do.
    if (kind === 'OptionCards' && !store.has(form, name)) {
      const d = storedDefault(type, def);
      if (d !== undefined) store.set(form, name, d, 'OptionCards');
    }
    const aggregate = (): Record<string, boolean> => {
      const stored = store.get(form, name) as Record<string, boolean> | undefined;
      return Object.fromEntries(items.map((it) => [it.value, stored?.[it.value] ?? it.checked ?? false]));
    };
    const selected = (): string[] => {
      if (kind === 'RadioGroup') { const v = store.get(form, name) ?? def; return typeof v === 'string' && v ? [v] : []; }
      if (kind === 'OptionCards') return normalizeSelection(type, store.get(form, name), def);
      const a = aggregate();
      return items.filter((it) => a[it.value]).map((it) => it.value);
    };
    const pick = (i: number) => {
      const it = items[i];
      if (!it) return;
      this.ctx.errors.delete(`${form}/${name}`);
      if (kind === 'RadioGroup') store.set(form, name, it.value);
      else if (kind === 'OptionCards') {
        const sel = selected();
        const next = type === 'single' ? (sel[0] === it.value ? [] : [it.value]) : sel.includes(it.value) ? sel.filter((v) => v !== it.value) : [...sel, it.value];
        store.set(form, name, type === 'single' ? next[0] : next, 'OptionCards');
      } else store.set(form, name, { ...aggregate(), [it.value]: !aggregate()[it.value] });
      this.ctx.ui.set(`${id}:hi`, i);
    };
    const hiKey = `${id}:hi`;
    // A single choice starts on its pick; a group of check boxes starts on its first box.
    const hi = () => Math.min(items.length - 1, Math.max(0, (this.ctx.ui.get(hiKey) as number | undefined) ?? (type === 'single' ? Math.max(0, items.findIndex((it) => selected().includes(it.value))) : 0)));
    this.ctx.widgets.set(id, {
      id,
      key: (ev) => {
        const h = hi();
        if ((ev.name === 'up' || ev.name === 'k') && !ev.ctrl) { if (h === 0) return false; this.ctx.ui.set(hiKey, h - 1); return true; }
        if ((ev.name === 'down' || ev.name === 'j') && !ev.ctrl) { if (h >= items.length - 1) return false; this.ctx.ui.set(hiKey, h + 1); return true; }
        if ((ev.name === 'space' || ev.name === 'enter' || ev.name === 'x') && !ev.ctrl) { pick(h); return true; }
        if (/^[1-9]$/.test(ev.name) && Number(ev.name) <= items.length) { pick(Number(ev.name) - 1); return true; }
        return false;
      },
      click: (part) => { if (part !== undefined) pick(Number(part)); },
    });
    const focused = this.ctx.focused === id;
    const sel = selected();
    const doc = this.doc;
    doc.begin(id);
    items.forEach((it, i) => {
      const on = sel.includes(it.value);
      const mark = kind === 'SwitchGroup' ? (on ? '[on ]' : '[off]') : type === 'single' ? (on ? g.radioOn : g.radioOff) : on ? g.checkOn : g.checkOff;
      const lit_ = focused && hi() === i;
      const target = `${id}#${i}`;
      const lead: Span[] = [...this.pad(), { text: lit_ ? `${g.marker} ` : '  ', style: s.focus, target }, { text: `${mark} `, style: on ? s.accent : {}, target }];
      const labelStyle: Style = { ...(on ? s.bold : {}), ...(lit_ ? { inverse: true } : {}) };
      const label = inlineSpans(it.label || it.value, this.ctx.md, labelStyle).map((sp) => ({ ...sp, target: sp.target ?? target }));
      const hang: Span[] = [...this.pad(), { text: ' '.repeat(2 + textWidth(mark) + 1), target }];
      doc.para(label, { first: lead, rest: hang });
      if (it.description) doc.para(inlineSpans(it.description, this.ctx.md, s.dim).map((sp) => ({ ...sp, target: sp.target ?? target })), { first: hang, rest: hang });
    });
    doc.end(id);
    this.register(form, name, lit(p['rules']));
    this.error(form, name);
  }

  private select(n: ElementNode, form: string): void {
    const p = n.props;
    const name = str(p['name']);
    const id = this.nextId('field', `${form}/${name}`);
    const store = this.ctx.store;
    const { s, g } = this.ctx.theme;
    const items = els(p['items']).map((it) => ({ value: str(it.props['value']), label: str(it.props['label']) || str(it.props['value']) })).filter((it) => it.value);
    const openKey = `${id}:open`;
    const hiKey = `${id}:hi`;
    const current = () => String(store.get(form, name) ?? '');
    const pick = (i: number) => { const it = items[i]; if (!it) return; store.set(form, name, it.value); this.ctx.ui.set(openKey, false); this.ctx.errors.delete(`${form}/${name}`); };
    const hi = () => (this.ctx.ui.get(hiKey) as number | undefined) ?? Math.max(0, items.findIndex((it) => it.value === current()));
    this.ctx.widgets.set(id, {
      id,
      key: (ev) => {
        const open = this.ctx.ui.get(openKey) === true;
        if (ev.name === 'enter' || ev.name === 'space') { if (open) pick(hi()); else { this.ctx.ui.set(hiKey, hi()); this.ctx.ui.set(openKey, true); } return true; }
        if (ev.name === 'escape' && open) { this.ctx.ui.set(openKey, false); return true; }
        if (open && (ev.name === 'up' || ev.name === 'k')) { this.ctx.ui.set(hiKey, Math.max(0, hi() - 1)); return true; }
        if (open && (ev.name === 'down' || ev.name === 'j')) { this.ctx.ui.set(hiKey, Math.min(items.length - 1, hi() + 1)); return true; }
        if ((ev.name === 'left' || ev.name === 'right') && items.length) {
          const at = items.findIndex((it) => it.value === current());
          const next = at < 0 ? 0 : (at + (ev.name === 'left' ? -1 : 1) + items.length) % items.length;
          store.set(form, name, items[next]!.value);
          return true;
        }
        return false;
      },
      click: (part) => {
        if (part === undefined) { this.ctx.ui.set(openKey, this.ctx.ui.get(openKey) !== true); this.ctx.ui.set(hiKey, hi()); return; }
        pick(Number(part));
      },
    });
    const focused = this.ctx.focused === id;
    const label = items.find((it) => it.value === current())?.label;
    const doc = this.doc;
    doc.begin(id);
    doc.push({ spans: [...this.pad(),
      { text: focused ? `${g.marker} ` : '  ', style: s.focus, target: id },
      { text: `[ ${sanitize(label ?? (str(p['placeholder']) || 'Select…'))} ${g.select} ]`, style: { ...(label ? {} : s.dim), ...(focused ? { inverse: true } : {}) }, target: id }] });
    if (this.ctx.ui.get(openKey) === true) {
      items.forEach((it, i) => {
        const on = it.value === current();
        doc.para([{ text: sanitize(it.label), style: focused && hi() === i ? { inverse: true } : on ? s.bold : {}, target: `${id}#${i}` }], { first: [...this.pad(), { text: `    ${on ? g.radioOn : g.radioOff} `, target: `${id}#${i}` }] });
      });
    }
    doc.end(id);
    this.register(form, name, lit(p['rules']));
    this.error(form, name);
  }

  private slider(n: ElementNode, form: string): void {
    const p = n.props;
    const name = str(p['name']);
    const id = this.nextId('field', `${form}/${name}`);
    const store = this.ctx.store;
    const { s, g } = this.ctx.theme;
    const min = Number(lit(p['min'])) || 0;
    const top = Number(lit(p['max']));
    const step = Number(lit(p['step'])) || 1;
    // A max the terminal cannot read, such as an expression, leaves a hundred steps above the min.
    const max = Number.isFinite(top) ? top : min + 100 * step;
    const value = (): number => {
      const v = (store.get(form, name) as number[] | undefined) ?? (lit(p['defaultValue']) as number[] | undefined);
      return Array.isArray(v) && typeof v[0] === 'number' ? v[0] : min;
    };
    const set = (v: number) => store.set(form, name, [Math.min(max, Math.max(min, Math.round(v / step) * step))]);
    this.ctx.widgets.set(id, {
      id,
      key: (ev) => {
        if (ev.name === 'left' || ev.name === 'h' || ev.name === '-') { set(value() - step); return true; }
        if (ev.name === 'right' || ev.name === 'l' || ev.name === '+') { set(value() + step); return true; }
        if (ev.name === 'home') { set(min); return true; }
        if (ev.name === 'end') { set(max); return true; }
        return false;
      },
      click: (part) => { if (part === 'down') set(value() - step); if (part === 'up') set(value() + step); },
    });
    const focused = this.ctx.focused === id;
    const label = str(p['label']) || name;
    this.doc.begin(id);
    this.doc.push({ spans: [...this.pad(),
      { text: focused ? `${g.marker} ` : '  ', style: s.focus, target: id },
      { text: `${sanitize(label)}: `, style: s.bold, target: id },
      { text: ' - ', style: focused ? { inverse: true } : {}, target: `${id}#down` },
      { text: ` ${value()} `, style: s.accent, target: id },
      { text: ' + ', style: focused ? { inverse: true } : {}, target: `${id}#up` },
      { text: `  (${min} to ${max})`, style: s.dim, target: id }] });
    this.doc.end(id);
    this.register(form, name, lit(p['rules']));
    this.error(form, name);
  }

  private checkWithText(n: ElementNode, form: string | undefined): void {
    const p = n.props;
    const { s, g } = this.ctx.theme;
    const id = this.nextId('reveal', str(p['label']));
    const openKey = `${id}:open`;
    const open = this.ctx.ui.get(openKey) === true;
    const check = els(p['check'])[0];
    if (check) this.node(check, form);
    this.ctx.widgets.set(id, { id, key: (ev) => { if (ev.name === 'enter' || ev.name === 'space') { this.ctx.ui.set(openKey, !open); return true; } return false; }, click: () => this.ctx.ui.set(openKey, !open) });
    const focused = this.ctx.focused === id;
    this.doc.begin(id);
    this.doc.para([{ text: `${open ? g.open : g.shut} `, style: s.accent, target: id }, ...inlineSpans(str(p['label']), this.ctx.md, { ...s.link, ...(focused ? { inverse: true } : {}) }).map((sp) => ({ ...sp, target: id }))], { first: [...this.pad(), { text: focused ? `${g.marker} ` : '  ', style: s.focus, target: id }] });
    this.doc.end(id);
    // Hidden content keeps its values in the store, so they still go with the answer.
    if (open) this.nested(4, () => els(p['content']).forEach((c) => this.node(c, form)));
  }

  private buttons(list: ElementNode[], form: string | undefined): void {
    const { s } = this.ctx.theme;
    let line: Span[] = [...this.pad()];
    let w = this.indent;
    const ids: string[] = [];
    const flush = () => {
      if (line.length > (this.indent ? 1 : 0)) {
        for (const id of ids) this.doc.begin(id);
        this.doc.push({ spans: line });
        for (const id of ids) this.doc.end(id);
      }
      line = [...this.pad()];
      w = this.indent;
      ids.length = 0;
    };
    for (const b of list) {
      const label = sanitize(str(b.props['label']));
      const variant = str(b.props['variant']) || 'primary';
      const action = buttonAction(b.props['action'], label);
      const id = this.nextId('button', label);
      const fire = () => {
        // A primary button that sends checks its form first, as OpenUI's does.
        if (variant === 'primary' && action.kind === 'assistant' && !this.validate(form)) return;
        this.ctx.onAction(action, form);
      };
      this.ctx.widgets.set(id, { id, key: (ev) => { if ((ev.name === 'enter' || ev.name === 'space') && !ev.ctrl) { fire(); return true; } return false; }, click: fire });
      const focused = this.ctx.focused === id;
      const text = action.kind === 'url' ? `[ ${label} ↗ ]` : `[ ${label} ]`;
      const tw = textWidth(text) + 1;
      if (w + tw > this.doc.width && w > this.indent) flush();
      const style: Style = { ...(variant === 'primary' ? s.primary : {}), ...(focused ? { inverse: true } : {}), ...(action.kind === 'url' ? { link: action.url } : {}) };
      line.push({ text, style, target: id }, { text: ' ' });
      ids.push(id);
      w += tw;
    }
    flush();
  }
}

/** The part of a string between two columns. */
function sliceCols(text: string, from: number, to: number): string {
  let col = 0;
  let out = '';
  for (const ch of Array.from(new Intl.Segmenter().segment(text), (x) => x.segment)) {
    const w = textWidth(ch);
    if (col >= from && col + w <= to) out += ch;
    col += w;
    if (col >= to) break;
  }
  return out;
}
