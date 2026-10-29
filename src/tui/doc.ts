// The card pane as a document: lines of styled text, wrapped to the pane's width, with the places a click lands
// (links, fields, buttons). The pane draws a window of it, so a long card scrolls.
import type { Grid, Style } from './screen.ts';
import { clusterWidth, graphemes, sanitize, textWidth } from './text.ts';

export interface Span {
  text: string;
  style?: Style;
  /** The id of what a click on this text does, such as a link or a field. */
  target?: string;
}

export interface Line {
  spans: Span[];
}

/** One stop of Tab in the card, with the lines it covers. */
export interface Stop {
  id: string;
  top: number;
  bottom: number;
}

export interface Hit { x0: number; x1: number; y: number; target: string; col: number; row: number }

export class Doc {
  readonly width: number;
  readonly lines: Line[] = [];
  readonly stops: Stop[] = [];
  private open = new Map<string, number>();

  constructor(width: number) {
    this.width = Math.max(10, width);
  }

  /** Add lines as they are: the caller has made them fit. */
  push(...lines: Line[]): void {
    this.lines.push(...lines);
  }

  /** One empty line, unless the document is empty or already ends with one. */
  gap(): void {
    const last = this.lines.at(-1);
    if (last && last.spans.some((s) => s.text.trim())) this.lines.push({ spans: [] });
  }

  /**
   * Styled text, wrapped to the width at spaces, with `first` before the first line and `rest` before the others,
   * so a list item hangs under its bullet. A line break in the text starts a new line.
   */
  para(spans: Span[], opts: { first?: Span[]; rest?: Span[]; width?: number } = {}): void {
    for (const line of wrapSpans(spans, opts.width ?? this.width, opts.first ?? [], opts.rest ?? opts.first?.map((s) => ({ text: ' '.repeat(textWidth(s.text)) })) ?? [])) this.lines.push(line);
  }

  /** Mark the lines from now until end(id) as one Tab stop. */
  begin(id: string): void {
    this.open.set(id, this.lines.length);
  }

  end(id: string): void {
    const top = this.open.get(id) ?? this.lines.length;
    this.open.delete(id);
    this.stops.push({ id, top, bottom: Math.max(top, this.lines.length - 1) });
  }

  stop(id: string): Stop | undefined {
    return this.stops.find((s) => s.id === id);
  }
}

/** Split spans into words and the spaces between them, each keeping its span's style and target. */
function tokens(spans: Span[]): { text: string; span: Span; space: boolean; brk: boolean }[] {
  const out: { text: string; span: Span; space: boolean; brk: boolean }[] = [];
  for (const span of spans) {
    const parts = sanitize(span.text).split(/(\n|[ ]+)/);
    for (const p of parts) {
      if (!p) continue;
      if (p === '\n') out.push({ text: '', span, space: false, brk: true });
      else out.push({ text: p, span, space: /^ +$/.test(p), brk: false });
    }
  }
  return out;
}

/** Spans wrapped into lines of at most `width` columns, prefixes included. */
export function wrapSpans(spans: Span[], width: number, first: Span[] = [], rest: Span[] = first): Line[] {
  const lines: Line[] = [];
  let cur: Span[] = [...first];
  let curW = first.reduce((w, s) => w + textWidth(s.text), 0);
  const restW = rest.reduce((w, s) => w + textWidth(s.text), 0);
  const startLine = () => { lines.push({ spans: trimEnd(cur) }); cur = [...rest]; curW = restW; };
  const add = (text: string, span: Span) => {
    const last = cur.at(-1);
    if (last && last.style === span.style && last.target === span.target && cur.length > rest.length) last.text += text;
    else cur.push({ text, style: span.style, target: span.target });
    curW += textWidth(text);
  };
  const avail = Math.max(1, width);
  for (const t of tokens(spans)) {
    if (t.brk) { startLine(); continue; }
    const w = textWidth(t.text);
    if (t.space) {
      if (curW > restW && curW + w <= avail) add(t.text, t.span);
      else if (curW + w > avail) startLine();
      continue;
    }
    if (curW + w <= avail) { add(t.text, t.span); continue; }
    if (curW > restW) startLine();
    // A word longer than the line breaks where it must.
    let gs = graphemes(t.text);
    while (gs.length) {
      let n = 0;
      let used = 0;
      while (n < gs.length && curW + used + clusterWidth(gs[n]!) <= avail) used += clusterWidth(gs[n++]!);
      if (n === 0 && curW === restW) n = 1;
      if (n === 0) { startLine(); continue; }
      add(gs.slice(0, n).join(''), t.span);
      gs = gs.slice(n);
      if (gs.length) startLine();
    }
  }
  lines.push({ spans: trimEnd(cur) });
  return lines;
}

function trimEnd(spans: Span[]): Span[] {
  const out = spans.map((s) => ({ ...s }));
  while (out.length && !out.at(-1)!.text.trim() && !out.at(-1)!.style?.inverse) out.pop();
  const last = out.at(-1);
  if (last && !last.style?.inverse) last.text = last.text.trimEnd();
  return out;
}

/** The width of a line. */
export const lineWidth = (l: Line): number => l.spans.reduce((w, s) => w + textWidth(s.text), 0);

/**
 * Draw the lines from `scroll` into the grid at (x, y), `h` rows high and `w` wide, and return where each clickable
 * span landed. Each hit also says which line and column of the document it covers, so a click can place a cursor.
 */
export function drawLines(grid: Grid, lines: Line[], x: number, y: number, w: number, h: number, scroll: number, base: Style = {}): Hit[] {
  const hits: Hit[] = [];
  for (let r = 0; r < h; r++) {
    const line = lines[scroll + r];
    if (!line) continue;
    let cx = x;
    let col = 0;
    for (const s of line.spans) {
      const start = cx;
      cx = grid.text(cx, y + r, s.text, { ...base, ...s.style }, x + w);
      if (s.target && cx > start) hits.push({ x0: start, x1: cx, y: y + r, target: s.target, col, row: scroll + r });
      col += textWidth(s.text);
      if (cx >= x + w) break;
    }
  }
  return hits;
}
