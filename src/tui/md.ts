// Card text as Markdown in the terminal. The page's own renderer, web/markdown.js, reads the Markdown, so both show
// the same subset the same way; this file draws its elements as styled lines.
import { SESSION_LINK, renderInline, renderMarkdown } from '../../web/markdown.js';
import { Doc, lineWidth, wrapSpans, type Line, type Span } from './doc.ts';
import { editRows } from './edit.ts';
import type { Style } from './screen.ts';
import { clip, sanitize, textWidth } from './text.ts';
import type { Theme } from './theme.ts';

/** An element as the renderer builds it. */
export interface MdNode { type: string; props: Record<string, unknown>; children: (MdNode | string)[] }

const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): MdNode =>
  ({ type, props: props ?? {}, children: (children.flat(Infinity) as (MdNode | string | null | false)[]).filter((c): c is MdNode | string => c !== null && c !== false && c !== undefined) });

export interface MdContext {
  theme: Theme;
  /** The title of a card that [[card-id]] links to, or undefined when the card is not in the inbox. */
  cardTitle?: (id: string) => string | undefined;
  /** The id of the Tab stop a link has, so the document can mark the focused one. */
  focused?: string;
  /** Called for each link, in order, so the caller can make it a Tab stop. */
  onLink?: (target: string) => void;
}

/** The target id of a link: a session link opens in herdr, a card link opens that card, any other opens its address. */
export const linkTarget = (href: string): string => (SESSION_LINK.test(href) ? `session:${href}` : `url:${href}`);

/** Inline Markdown as spans: code, bold, italic and links. */
export function inlineSpans(text: string, ctx: MdContext, base: Style = {}): Span[] {
  return spansOf(renderInline(h, sanitize(text), cardLinkOpts(ctx)), ctx, base);
}

function cardLinkOpts(ctx: MdContext) {
  return {
    cardLink: (id: string) => h('cardlink', { id }, ctx.cardTitle?.(id) ?? id),
    diagram: (source: string) => h('diagram', { source }),
    breaks: true,
  };
}

function spansOf(nodes: (MdNode | string)[], ctx: MdContext, base: Style): Span[] {
  const out: Span[] = [];
  const { s, g, caps } = ctx.theme;
  const walk = (n: MdNode | string, style: Style, target?: string) => {
    if (typeof n === 'string') { out.push({ text: n, style, target }); return; }
    if (n.type === 'strong') { n.children.forEach((c) => walk(c, { ...style, bold: true }, target)); return; }
    if (n.type === 'em') { n.children.forEach((c) => walk(c, { ...style, italic: true }, target)); return; }
    if (n.type === 'code') {
      // Without color, code keeps its backticks, so it still reads as code.
      const text = n.children.join('');
      out.push({ text: caps.color === 0 ? `\`${text}\`` : text, style: { ...style, ...s.code }, target });
      return;
    }
    if (n.type === 'a') {
      const href = String(n.props['href'] ?? '');
      const t = linkTarget(href);
      ctx.onLink?.(t);
      const focused = ctx.focused === t;
      const look: Style = { ...style, ...s.link, ...(SESSION_LINK.test(href) ? {} : { link: href }), ...(focused ? { inverse: true } : {}) };
      if (SESSION_LINK.test(href)) out.push({ text: `${g.session} `, style: look, target: t });
      n.children.forEach((c) => walk(c, look, t));
      return;
    }
    if (n.type === 'cardlink') {
      const id = String(n.props['id']);
      const known = ctx.cardTitle?.(id) !== undefined;
      const t = `card:${id}`;
      if (known) ctx.onLink?.(t);
      const look: Style = known ? { ...style, ...s.link, ...(ctx.focused === t ? { inverse: true } : {}) } : { ...style, ...s.dim, italic: true };
      n.children.forEach((c) => walk(c, look, known ? t : undefined));
      return;
    }
    n.children.forEach((c) => walk(c, style, target));
  };
  nodes.forEach((n) => walk(n, base));
  return out;
}

/** Markdown blocks drawn into the document, indented by `indent` columns. */
export function markdown(doc: Doc, text: string, ctx: MdContext, indent = 0, base: Style = {}): void {
  const blocks = renderMarkdown(h, sanitize(text), cardLinkOpts(ctx));
  const pad: Span[] = indent ? [{ text: ' '.repeat(indent) }] : [];
  const width = doc.width;
  const { s, g } = ctx.theme;
  blocks.forEach((b, i) => {
    if (i) doc.gap();
    block(doc, b, ctx, pad, width, base, s, g);
  });
}

function block(doc: Doc, b: MdNode, ctx: MdContext, pad: Span[], width: number, base: Style, s: Theme['s'], g: Theme['g']): void {
  const kids = (n: MdNode, style: Style = base) => spansOf(n.children, ctx, style);
  if (/^h[1-6]$/.test(b.type)) { doc.para(kids(b, { ...base, ...s.heading }), { first: pad }); return; }
  if (b.type === 'p') { doc.para(kids(b), { first: pad }); return; }
  if (b.type === 'ul' || b.type === 'ol') {
    b.children.forEach((li, j) => {
      if (typeof li === 'string') return;
      const mark = b.type === 'ol' ? `${j + 1}. ` : `${g.bullet} `;
      doc.para(kids(li), { first: [...pad, { text: mark, style: s.dim }], rest: [...pad, { text: ' '.repeat(textWidth(mark)) }] });
    });
    return;
  }
  if (b.type === 'blockquote') {
    const bar: Span[] = [...pad, { text: `${g.quote} `, style: s.dim }];
    doc.para(kids(b, { ...base, ...s.dim }), { first: bar, rest: bar });
    return;
  }
  if (b.type === 'diagram') { diagram(doc, String(b.props['source'] ?? ''), pad, ctx.theme); return; }
  if (b.type === 'pre') {
    const code = b.children.map((c) => (typeof c === 'string' ? c : c.children.join(''))).join('');
    codeBlock(doc, code, pad, ctx.theme);
    return;
  }
  if (b.type === 'table') {
    const rows: Span[][][] = [];
    for (const part of b.children) {
      if (typeof part === 'string') continue;
      for (const tr of part.children) {
        if (typeof tr === 'string') continue;
        rows.push(tr.children.map((cell) => (typeof cell === 'string' ? [{ text: cell }] : kids(cell, cell.type === 'th' ? { ...base, bold: true } : base))));
      }
    }
    table(doc, rows, pad, ctx.theme);
  }
}

/** A Mermaid diagram: the terminal shows its source, and says the page draws it. */
export function diagram(doc: Doc, source: string, pad: Span[], theme: Theme): void {
  doc.para([{ text: 'A diagram, drawn on the page in the browser. Its source:', style: theme.s.dim }], { first: pad });
  codeBlock(doc, source, pad, theme);
}

/** Code as it is, line by line, behind a bar. A line wider than the pane breaks. */
export function codeBlock(doc: Doc, code: string, pad: Span[], theme: Theme): void {
  const bar: Span[] = [...pad, { text: `${theme.g.quote} `, style: theme.s.dim }];
  const barW = bar.reduce((w, sp) => w + textWidth(sp.text), 0);
  // Code keeps its spaces: each line breaks by character where it is wider than the pane.
  for (const row of editRows(sanitize(code).replace(/\n$/, ''), Math.max(4, doc.width - barW))) {
    doc.push({ spans: [...bar, { text: row.text, style: theme.caps.color ? theme.s.code : {} }] });
  }
}

/**
 * A table: the first row is the header. Columns share the width, each at least its header; text in a cell wraps
 * inside its column. When even that does not fit, each row prints as "header: value" lines.
 */
export function table(doc: Doc, rows: Span[][][], pad: Span[], theme: Theme): void {
  if (!rows.length) return;
  const { g, s } = theme;
  const cols = Math.max(...rows.map((r) => r.length));
  const padW = pad.reduce((w, p) => w + textWidth(p.text), 0);
  const avail = doc.width - padW - (cols - 1) * 3;
  const natural = Array.from({ length: cols }, (_, c) => Math.max(1, ...rows.map((r) => lineWidth({ spans: r[c] ?? [] }))));
  const header = rows[0]!;
  const min = Array.from({ length: cols }, (_, c) => Math.min(natural[c]!, Math.max(4, ...(header[c] ?? []).map((sp) => Math.min(12, textWidth(sp.text))))));
  if (min.reduce((a, b) => a + b, 0) > avail) {
    // Too narrow for columns: one block per row.
    rows.slice(1).forEach((r, i) => {
      if (i) doc.gap();
      r.forEach((cell, c) => doc.para([{ text: `${clip(header[c]?.map((sp) => sp.text).join('') ?? '', 30)}: `, style: s.bold }, ...cell], { first: pad, rest: [...pad, { text: '  ' }] }));
    });
    return;
  }
  // Give each column its natural width, then shrink the widest until the table fits.
  const w = [...natural];
  while (w.reduce((a, b) => a + b, 0) > avail) {
    let widest = 0;
    for (let c = 1; c < cols; c++) if (w[c]! - min[c]! > w[widest]! - min[widest]!) widest = c;
    if (w[widest]! <= min[widest]!) break;
    w[widest]!--;
  }
  const sep = { text: ` ${g.table.v} `, style: s.dim };
  rows.forEach((r, ri) => {
    const wrapped = Array.from({ length: cols }, (_, c) => wrapSpans(r[c] ?? [], w[c]!));
    const height = Math.max(...wrapped.map((x) => x.length));
    for (let k = 0; k < height; k++) {
      const spans: Span[] = [...pad];
      for (let c = 0; c < cols; c++) {
        if (c) spans.push(sep);
        const line = wrapped[c]![k] ?? { spans: [] };
        spans.push(...line.spans, { text: ' '.repeat(Math.max(0, w[c]! - lineWidth(line))) });
      }
      doc.push({ spans });
    }
    if (ri === 0) doc.push({ spans: [...pad, { text: w.map((x) => g.table.h.repeat(x)).join(`${g.table.h}${g.table.x}${g.table.h}`), style: s.dim }] });
  });
}

export type { Line };
