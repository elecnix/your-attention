// Editing text in a field: the value, the cursor, and the keys a person expects in a terminal text box.
// Lines wrap at the box's width by character, so each screen position maps to one place in the text.
import type { KeyEvent } from './input.ts';
import { clusterWidth, graphemes } from './text.ts';

export interface EditState { value: string; cursor: number }

/** The text as rows of at most `width` columns, with the index in the value where each row starts and ends. */
export function editRows(value: string, width: number): { text: string; start: number; end: number }[] {
  const w = Math.max(1, width);
  const rows: { text: string; start: number; end: number }[] = [];
  let at = 0;
  for (const line of value.split('\n')) {
    let start = at;
    let text = '';
    let used = 0;
    for (const g of graphemes(line)) {
      const cw = clusterWidth(g);
      if (used + cw > w && text) { rows.push({ text, start, end: at }); start = at; text = ''; used = 0; }
      text += g;
      used += cw;
      at += g.length;
    }
    rows.push({ text, start, end: at });
    at += 1;
  }
  return rows;
}

/** The row and column of the cursor. */
export function cursorPos(state: EditState, width: number): { row: number; col: number } {
  const rows = editRows(state.value, width);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const next = rows[r + 1];
    // At a wrap point the cursor sits at the start of the next row, unless the row ends the line.
    if (state.cursor >= row.start && (state.cursor < row.end || (state.cursor === row.end && (!next || next.start !== row.end)))) {
      return { row: r, col: colOf(row.text, state.cursor - row.start) };
    }
  }
  const last = rows.length - 1;
  return { row: last, col: colOf(rows[last]!.text, rows[last]!.text.length) };
}

const colOf = (text: string, chars: number): number => {
  let col = 0;
  let n = 0;
  for (const g of graphemes(text)) { if (n >= chars) break; n += g.length; col += clusterWidth(g); }
  return col;
};

/** The index in the value at a row and column, as a click lands. */
export function indexAt(value: string, width: number, row: number, col: number): number {
  const rows = editRows(value, width);
  const r = rows[Math.max(0, Math.min(row, rows.length - 1))]!;
  let at = r.start;
  let used = 0;
  for (const g of graphemes(r.text)) {
    const cw = clusterWidth(g);
    if (used + cw / 2 > col) break;
    used += cw;
    at += g.length;
  }
  return at;
}

const prevBoundary = (v: string, i: number): number => {
  let at = 0;
  for (const g of graphemes(v.slice(0, i))) { if (at + g.length >= i) return at; at += g.length; }
  return 0;
};
const nextBoundary = (v: string, i: number): number => i + (graphemes(v.slice(i))[0]?.length ?? 0);
/** The start of the grapheme that holds index i, so a word jump never stops inside one. */
const snap = (v: string, i: number): number => { let at = 0; for (const g of graphemes(v)) { if (at + g.length > i) return at; at += g.length; } return v.length; };
const wordLeft = (v: string, i: number): number => { let j = i; while (j > 0 && /\s/.test(v[j - 1]!)) j--; while (j > 0 && !/\s/.test(v[j - 1]!)) j--; return snap(v, j); };
const wordRight = (v: string, i: number): number => { let j = i; while (j < v.length && /\s/.test(v[j]!)) j++; while (j < v.length && !/\s/.test(v[j]!)) j++; return j < v.length ? snap(v, j) : j; };
const lineStart = (v: string, i: number): number => (i <= 0 ? 0 : v.lastIndexOf('\n', i - 1) + 1);
const lineEnd = (v: string, i: number): number => { const e = v.indexOf('\n', i); return e < 0 ? v.length : e; };

/**
 * The state after a key, or undefined when the field does not use the key, such as Tab or, in a one-line field,
 * Up and Down. Enter adds a line in a multi-line field.
 */
export function editKey(state: EditState, ev: KeyEvent, opts: { multiline: boolean; width: number }): EditState | undefined {
  const { value: v, cursor: c } = state;
  const set = (value: string, cursor: number): EditState => ({ value, cursor: Math.max(0, Math.min(value.length, cursor)) });
  if (ev.text !== undefined && !ev.ctrl && !ev.alt) return set(v.slice(0, c) + ev.text + v.slice(c), c + ev.text.length);
  const name = ev.name;
  if (name === 'enter' && !ev.ctrl && !ev.alt) return opts.multiline ? set(`${v.slice(0, c)}\n${v.slice(c)}`, c + 1) : undefined;
  if (name === 'backspace') {
    if (ev.ctrl || ev.alt) { const j = wordLeft(v, c); return set(v.slice(0, j) + v.slice(c), j); }
    const j = prevBoundary(v, c);
    return set(v.slice(0, j) + v.slice(c), j);
  }
  if (name === 'delete') return set(v.slice(0, c) + v.slice(nextBoundary(v, c)), c);
  if (name === 'left') return set(v, ev.ctrl || ev.alt ? wordLeft(v, c) : prevBoundary(v, c));
  if (name === 'right') return set(v, ev.ctrl || ev.alt ? wordRight(v, c) : nextBoundary(v, c));
  if (name === 'home' || (ev.ctrl && name === 'a')) return set(v, lineStart(v, c));
  if (name === 'end' || (ev.ctrl && name === 'e')) return set(v, lineEnd(v, c));
  if (ev.alt && name === 'b') return set(v, wordLeft(v, c));
  if (ev.alt && name === 'f') return set(v, wordRight(v, c));
  if (ev.ctrl && name === 'w') { const j = wordLeft(v, c); return set(v.slice(0, j) + v.slice(c), j); }
  if (ev.ctrl && name === 'u') { const j = lineStart(v, c); return set(v.slice(0, j) + v.slice(c), j); }
  if (ev.ctrl && name === 'k') { const j = lineEnd(v, c); return set(v.slice(0, c) + v.slice(j === c && j < v.length ? j + 1 : j), c); }
  if ((name === 'up' || name === 'down') && opts.multiline) {
    const pos = cursorPos(state, opts.width);
    const rows = editRows(v, opts.width);
    const row = pos.row + (name === 'up' ? -1 : 1);
    if (row < 0 || row >= rows.length) return undefined;
    return set(v, indexAt(v, opts.width, row, pos.col));
  }
  return undefined;
}

/** Pasted text goes in at the cursor. A one-line field takes the lines joined with spaces. */
export function editPaste(state: EditState, text: string, multiline: boolean): EditState {
  const t = multiline ? text : text.replace(/\n+/g, ' ');
  return { value: state.value.slice(0, state.cursor) + t + state.value.slice(state.cursor), cursor: state.cursor + t.length };
}
