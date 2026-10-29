// Text as a terminal draws it: the width of each character, the characters an agent may not send to the screen,
// and wrapping and clipping to a number of columns.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|\p{Regional_Indicator}{2}/u;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]/u;

/** East Asian wide and fullwidth ranges, as [first, last] code points. */
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** The grapheme clusters of a string: what a person reads as one character each. */
export function graphemes(s: string): string[] {
  if (PRINTABLE_ASCII.test(s)) return s.split('');
  return Array.from(segmenter.segment(s), (g) => g.segment);
}

/** The columns one grapheme cluster takes: 0, 1 or 2. */
export function clusterWidth(g: string): number {
  if (g.length === 1 && g >= ' ' && g <= '~') return 1;
  if (EMOJI.test(g)) return 2;
  if (ZERO.test(g)) return 0;
  const cp = g.codePointAt(0) ?? 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

/** The columns a string takes on screen. */
export function textWidth(s: string): number {
  if (PRINTABLE_ASCII.test(s)) return s.length;
  let w = 0;
  for (const g of graphemes(s)) w += clusterWidth(g);
  return w;
}

/**
 * Card text comes from agents, so it must never reach the terminal as a command: this drops escape and other control
 * characters, and the bidirectional overrides that can make text read differently from what it is. A tab becomes two
 * spaces. A line break stays, for the caller to split on.
 */
export function sanitize(s: string): string {
  return String(s ?? '').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/g, '');
}

/** The longest start of `s` that fits in `width` columns. */
function fit(gs: string[], width: number): number {
  let w = 0;
  let i = 0;
  for (; i < gs.length; i++) {
    const cw = clusterWidth(gs[i] ?? '');
    if (w + cw > width) break;
    w += cw;
  }
  return i;
}

/** One paragraph, wrapped at spaces into lines of at most `width` columns. A word longer than a line breaks. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  if (textWidth(text) <= w) return [text];
  const lines: string[] = [];
  let line = '';
  let lineW = 0;
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    const tw = textWidth(token);
    if (/^\s+$/.test(token)) {
      if (line && lineW + tw <= w) { line += token; lineW += tw; } else if (line) { lines.push(line.trimEnd()); line = ''; lineW = 0; }
      continue;
    }
    if (lineW + tw <= w) { line += token; lineW += tw; continue; }
    if (line) { lines.push(line.trimEnd()); line = ''; lineW = 0; }
    let gs = graphemes(token);
    while (textWidth(gs.join('')) > w) {
      const n = Math.max(1, fit(gs, w));
      lines.push(gs.slice(0, n).join(''));
      gs = gs.slice(n);
    }
    line = gs.join('');
    lineW = textWidth(line);
  }
  if (line || !lines.length) lines.push(line.trimEnd());
  return lines;
}

/** `s` cut to `width` columns, ending with an ellipsis when it was cut. */
export function clip(s: string, width: number, ellipsis = '…'): string {
  if (textWidth(s) <= width) return s;
  const ew = textWidth(ellipsis);
  if (width <= ew) return graphemes(ellipsis).slice(0, Math.max(0, width)).join('');
  const gs = graphemes(s);
  return gs.slice(0, fit(gs, width - ew)).join('') + ellipsis;
}

/** `s` padded with spaces, or clipped, to exactly `width` columns. */
export function pad(s: string, width: number): string {
  const c = clip(s, width);
  return c + ' '.repeat(Math.max(0, width - textWidth(c)));
}
