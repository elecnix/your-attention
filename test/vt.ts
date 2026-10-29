// A small terminal emulator for tests: it reads what the terminal client writes and keeps the screen it would show,
// with the attributes a test checks. It knows the sequences the client sends, and skips the others.
import { clusterWidth, graphemes } from '../src/tui/text.ts';

export interface VtCell { ch: string; bold: boolean; inverse: boolean; underline: boolean; dim: boolean; fg: string | null; link: string | null }

export class Vt {
  cols: number;
  rows: number;
  cells: VtCell[][];
  x = 0;
  y = 0;
  /** DEC private modes the client turned on and not off, such as 1049 for the alternate screen. */
  modes = new Set<number>();
  private pending = '';
  private attr: Omit<VtCell, 'ch'> = blank();
  /** Every byte written, for checks on what was sent. */
  raw = '';

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = this.empty();
  }

  private empty(): VtCell[][] {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ({ ch: ' ', ...blank() })));
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.cells = this.empty();
  }

  write(data: string): void {
    this.raw += data;
    let s = this.pending + data;
    this.pending = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === '\x1b') {
        const rest = s.slice(i);
        const csi = /^\x1b\[([?<>=]?)([\d;:]*)([ -/]*)([@-~])/.exec(rest);
        if (csi) { this.csi(csi[1]!, csi[2]!, csi[4]!); i += csi[0].length; continue; }
        const osc = /^\x1b\]([^\x07\x1b]*)(\x07|\x1b\\)/.exec(rest);
        if (osc) { this.osc(osc[1]!); i += osc[0].length; continue; }
        if (/^\x1b(\[[?<>=]?[\d;:]*[ -/]*|\][^\x07\x1b]*(\x1b)?)?$/.test(rest)) { this.pending = rest; return; }
        i += 2;
        continue;
      }
      if (c === '\r') { this.x = 0; i++; continue; }
      if (c === '\n') { this.y = Math.min(this.rows - 1, this.y + 1); i++; continue; }
      if (c < ' ' || c === '\x7f') { i++; continue; }
      // One grapheme: read up to the next control character.
      let j = i;
      while (j < s.length && s[j]! >= ' ' && s[j] !== '\x7f' && s[j] !== '\x1b') j++;
      for (const g of graphemes(s.slice(i, j))) this.put(g);
      i = j;
    }
    s = '';
  }

  private put(g: string): void {
    const w = clusterWidth(g);
    if (w === 0) return;
    if (this.y >= this.rows || this.x >= this.cols) return;
    const row = this.cells[this.y]!;
    row[this.x] = { ch: g, ...this.attr };
    if (w === 2 && this.x + 1 < this.cols) row[this.x + 1] = { ch: '', ...this.attr };
    this.x += w;
  }

  private csi(prefix: string, params: string, final: string): void {
    const n = params.split(';').map((p) => (p === '' ? NaN : Number(p.split(':')[0])));
    const p = (k: number, d: number) => (Number.isNaN(n[k] ?? NaN) ? d : n[k]!);
    if (prefix === '?' && (final === 'h' || final === 'l')) {
      for (const m of n) if (!Number.isNaN(m)) { if (final === 'h') this.modes.add(m); else this.modes.delete(m); }
      if (n.includes(1049) && final === 'h') this.cells = this.empty();
      return;
    }
    if (prefix) return;
    if (final === 'H' || final === 'f') { this.y = p(0, 1) - 1; this.x = p(1, 1) - 1; return; }
    if (final === 'J') { if (p(0, 0) === 2) this.cells = this.empty(); return; }
    if (final === 'K') { const row = this.cells[this.y]; if (row) for (let x = this.x; x < this.cols; x++) row[x] = { ch: ' ', ...this.attr }; return; }
    if (final === 'm') this.sgr(params);
  }

  private sgr(params: string): void {
    const n = params === '' ? [0] : params.split(';').map(Number);
    for (let k = 0; k < n.length; k++) {
      const v = n[k]!;
      if (v === 0) this.attr = { ...blank(), link: this.attr.link };
      else if (v === 1) this.attr.bold = true;
      else if (v === 2) this.attr.dim = true;
      else if (v === 4) this.attr.underline = true;
      else if (v === 7) this.attr.inverse = true;
      else if (v === 22) { this.attr.bold = false; this.attr.dim = false; }
      else if (v === 24) this.attr.underline = false;
      else if (v === 27) this.attr.inverse = false;
      else if (v === 39) this.attr.fg = null;
      else if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) this.attr.fg = String(v);
      else if (v === 38 && n[k + 1] === 5) { this.attr.fg = `5;${n[k + 2]}`; k += 2; }
      else if (v === 38 && n[k + 1] === 2) { this.attr.fg = `#${[n[k + 2], n[k + 3], n[k + 4]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`; k += 4; }
      else if (v === 48 && n[k + 1] === 5) k += 2;
      else if (v === 48 && n[k + 1] === 2) k += 4;
    }
  }

  private osc(body: string): void {
    const m = /^8;[^;]*;(.*)$/.exec(body);
    if (m) this.attr.link = m[1] || null;
  }

  /** The screen as plain text, one string per row, with trailing spaces trimmed. */
  lines(): string[] {
    return this.cells.map((row) => row.map((c) => c.ch).join('').trimEnd());
  }

  text(): string {
    return this.lines().join('\n');
  }

  /** The row and column of the first place `needle` shows, or undefined. */
  find(needle: string): { x: number; y: number } | undefined {
    for (let y = 0; y < this.rows; y++) {
      const row = this.cells[y]!;
      const chars = row.map((c) => c.ch);
      const line = chars.join('');
      const at = line.indexOf(needle);
      if (at < 0) continue;
      // Convert the string index to a column: wide characters leave an empty string after them.
      let col = 0;
      let len = 0;
      for (; col < chars.length && len < at; col++) len += chars[col]!.length;
      while (col < chars.length && chars[col] === '') col++;
      return { x: col, y };
    }
    return undefined;
  }

  cell(x: number, y: number): VtCell | undefined {
    return this.cells[y]?.[x];
  }
}

function blank(): Omit<VtCell, 'ch'> {
  return { bold: false, inverse: false, underline: false, dim: false, fg: null, link: null };
}
