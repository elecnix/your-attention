// A grid of cells, one frame of the screen, and the escape sequences that turn the last frame into the next one.
// Only rows that changed are written, from their first changed cell to their last, inside a synchronized update so the
// terminal shows the whole frame at once. pi's terminal UI renders the same way: compare with the last frame, write
// the difference, and wrap it in mode 2026.
import { clusterWidth, graphemes } from './text.ts';

/** A color: a palette index from 0 to 15, or #rrggbb. */
export type Color = number | string;

export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  /** An address the terminal can open, sent as an OSC 8 hyperlink. */
  link?: string;
}

/** What the terminal can show. */
export interface Caps {
  /** 0: no colors at all; 1: the 16 palette colors; 2: 256 colors; 3: 24-bit color. */
  color: 0 | 1 | 2 | 3;
  /** Box drawing and symbols, or ASCII only. */
  unicode: boolean;
  /** OSC 8 hyperlinks. */
  hyperlinks: boolean;
}

const styleIds = new Map<string, number>();
const styles: Style[] = [{}];
styleIds.set('{}', 0);

/** A number for a style, the same for equal styles, so cells compare by number. */
export function styleId(s: Style): number {
  const key = JSON.stringify(s, Object.keys(s).sort());
  let id = styleIds.get(key);
  if (id === undefined) {
    id = styles.length;
    styles.push({ ...s });
    styleIds.set(key, id);
  }
  return id;
}

export class Grid {
  readonly width: number;
  readonly height: number;
  /** One grapheme per cell. The cell after a wide character holds ''. */
  readonly chars: string[];
  readonly styles: Uint32Array;

  constructor(width: number, height: number) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.chars = new Array<string>(this.width * this.height).fill(' ');
    this.styles = new Uint32Array(this.width * this.height);
  }

  clone(): Grid {
    const g = new Grid(this.width, this.height);
    for (let i = 0; i < this.chars.length; i++) g.chars[i] = this.chars[i]!;
    g.styles.set(this.styles);
    return g;
  }

  clear(): void {
    this.chars.fill(' ');
    this.styles.fill(0);
  }

  /**
   * Set one cell. Every write goes through here, so a row stays one grapheme per cell: writing over either half of a
   * wide character blanks its other half.
   */
  private put(x: number, y: number, ch: string, id: number): void {
    const row = y * this.width;
    if (this.chars[row + x] === '' && x > 0) this.chars[row + x - 1] = ' ';
    if (x + 1 < this.width && this.chars[row + x + 1] === '' && ch !== '') this.chars[row + x + 1] = ' ';
    this.chars[row + x] = ch;
    this.styles[row + x] = id;
  }

  /** Fill `w` cells from (x, y) with one character. */
  fill(x: number, y: number, w: number, ch: string, style: Style = {}): void {
    if (y < 0 || y >= this.height) return;
    const id = styleId(style);
    for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) this.put(i, y, ch, id);
  }

  /** Add a style to cells that already hold text, such as the inverse video of a selected row. */
  restyle(x: number, y: number, w: number, extra: Style): void {
    if (y < 0 || y >= this.height) return;
    for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
      const at = y * this.width + i;
      this.styles[at] = styleId({ ...styles[this.styles[at]!], ...extra });
    }
  }

  /**
   * Write text from (x, y), clipped at `maxX` (the grid's width by default). The text must be sanitized and one line.
   * A wide character that would cross the edge leaves a space. Returns the column after the text.
   */
  text(x: number, y: number, s: string, style: Style = {}, maxX = this.width): number {
    if (y < 0 || y >= this.height) return x;
    const end = Math.min(maxX, this.width);
    const id = styleId(style);
    for (const g of graphemes(s)) {
      const w = clusterWidth(g);
      if (w === 0) continue;
      if (x + w > end) {
        if (x >= 0 && x < end) { this.put(x, y, ' ', id); x++; }
        break;
      }
      if (x >= 0) {
        this.put(x, y, g, id);
        if (w === 2) this.put(x + 1, y, '', id);
      }
      x += w;
    }
    return x;
  }

  /** The text of one row, for tests and for search. */
  row(y: number): string {
    return this.chars.slice(y * this.width, (y + 1) * this.width).join('');
  }
}

// A palette close to most terminals' defaults, for the 16-color mode.
const PALETTE: [number, number, number][] = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];
const dist = (a: number[], b: number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

function rgb(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : undefined;
}

/** The SGR parameters for a color at a color depth, foreground or background. Empty in monochrome. */
export function sgrColor(c: Color, depth: Caps['color'], background: boolean): string {
  if (depth === 0) return '';
  const base16 = (i: number) => String((i < 8 ? 30 + i : 90 + i - 8) + (background ? 10 : 0));
  if (typeof c === 'number') return base16(c);
  const v = rgb(c);
  if (!v) return '';
  if (depth === 3) return `${background ? 48 : 38};2;${v[0]};${v[1]};${v[2]}`;
  if (depth === 2) {
    const idx = v.map((x) => CUBE.reduce((best, lvl, i) => (Math.abs(lvl - x) < Math.abs(CUBE[best]! - x) ? i : best), 0));
    const cube = idx.map((i) => CUBE[i]!);
    const avg = Math.round((v[0] + v[1] + v[2]) / 3);
    const k = Math.min(23, Math.max(0, Math.round((avg - 8) / 10)));
    const gray = 8 + 10 * k;
    const n = dist(v, cube) <= dist(v, [gray, gray, gray]) ? 16 + 36 * idx[0]! + 6 * idx[1]! + idx[2]! : 232 + k;
    return `${background ? 48 : 38};5;${n}`;
  }
  // Black and white read as no color on one of the two usual backgrounds, so a foreground never takes them.
  const choices = background ? [...PALETTE.keys()] : [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];
  const best = choices.reduce((b, i) => (dist(v, PALETTE[i]!) < dist(v, PALETTE[b]!) ? i : b), choices[0]!);
  return base16(best);
}

function sgr(s: Style, caps: Caps): string {
  const p = ['0'];
  if (s.bold) p.push('1');
  if (s.dim) p.push('2');
  if (s.italic) p.push('3');
  if (s.underline) p.push('4');
  if (s.inverse) p.push('7');
  if (s.fg !== undefined) { const c = sgrColor(s.fg, caps.color, false); if (c) p.push(c); }
  if (s.bg !== undefined) { const c = sgrColor(s.bg, caps.color, true); if (c) p.push(c); }
  return `\x1b[${p.join(';')}m`;
}

/** An OSC 8 link, or the end of one. The address is checked, since a link is the one place text reaches a terminal command. */
function osc8(url: string | undefined): string {
  if (!url) return '\x1b]8;;\x1b\\';
  return /^(https?:|mailto:)[^\x00-\x20\x7f-\x9f]*$/i.test(url) ? `\x1b]8;;${url}\x1b\\` : '\x1b]8;;\x1b\\';
}

/**
 * The escape sequences that turn `prev` into `next`: every row when `prev` is null or another size, else only the
 * changed runs. Empty when nothing changed.
 */
export function encodeFrame(prev: Grid | null, next: Grid, caps: Caps): string {
  const full = !prev || prev.width !== next.width || prev.height !== next.height;
  const w = next.width;
  let out = '';
  let cur = -1;
  let link: string | undefined;
  for (let y = 0; y < next.height; y++) {
    let first = 0;
    let last = w - 1;
    if (!full) {
      const o = y * w;
      while (first < w && prev.chars[o + first] === next.chars[o + first] && prev.styles[o + first] === next.styles[o + first]) first++;
      if (first === w) continue;
      while (last > first && prev.chars[o + last] === next.chars[o + last] && prev.styles[o + last] === next.styles[o + last]) last--;
      // A run never starts on the second half of a wide character, nor ends on its first half.
      if (first > 0 && next.chars[o + first] === '') first--;
      if (last + 1 < w && next.chars[o + last + 1] === '') last++;
    }
    out += `\x1b[${y + 1};${first + 1}H`;
    for (let x = first; x <= last; x++) {
      const ch = next.chars[y * w + x]!;
      if (ch === '') continue;
      const id = next.styles[y * w + x]!;
      if (id !== cur) {
        const s = styles[id]!;
        out += sgr(s, caps);
        if (caps.hyperlinks && s.link !== link) { out += osc8(s.link); link = s.link; }
        cur = id;
      }
      out += ch;
    }
  }
  if (!out) return '';
  if (link) out += osc8(undefined);
  return `\x1b[?2026h${out}\x1b[0m\x1b[?2026l`;
}
