// Bytes from the terminal, decoded into keys, mouse events, pastes and focus changes. It reads the legacy encodings,
// xterm's modifyOtherKeys and the kitty keyboard protocol, SGR mouse reports (mode 1006) and bracketed paste (mode 2004).
// A sequence can arrive split across reads, so an unfinished one waits for the next read. A lone Escape waits too:
// the caller calls flush() after a short pause, the way pi's StdinBuffer, adapted from OpenTUI, tells Escape from a sequence.
import { graphemes } from './text.ts';

export interface KeyEvent { type: 'key'; name: string; text?: string; ctrl: boolean; alt: boolean; shift: boolean }
export interface MouseEvent {
  type: 'mouse';
  action: 'down' | 'up' | 'drag' | 'move' | 'wheel-up' | 'wheel-down';
  /** 0 left, 1 middle, 2 right. */
  button: number;
  /** Zero-based column and row. */
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}
export type InputEvent =
  | KeyEvent
  | MouseEvent
  | { type: 'paste'; text: string }
  | { type: 'focus'; on: boolean }
  | { type: 'reply'; kind: 'kitty' | 'attributes'; value: string };

const CSI = /^\x1b\[([<?>=]?)([\d;:]*)([\x20-\x2f]*)([\x40-\x7e])/;
const CSI_PREFIX = /^\x1b\[[<?>=]?[\d;:]*[\x20-\x2f]*$/;
const PASTE_END = '\x1b[201~';

const TILDE: Record<number, string> = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end', 11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' };
const LETTER: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };

function key(name: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, text?: string): KeyEvent {
  const e: KeyEvent = { type: 'key', name, ctrl: !!mods.ctrl, alt: !!mods.alt, shift: !!mods.shift };
  if (text !== undefined && !e.ctrl && !e.alt) e.text = text;
  return e;
}

/** The modifiers of a CSI parameter: 1 plus shift 1, alt 2 and ctrl 4. */
function mods(n: number | undefined): { ctrl: boolean; alt: boolean; shift: boolean } {
  const m = Math.max(0, (n ?? 1) - 1);
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

/** A key by its Unicode code point, as kitty and modifyOtherKeys report it. */
function codeKey(code: number, m: { ctrl: boolean; alt: boolean; shift: boolean }): KeyEvent {
  if (code === 13 || code === 57414) return key('enter', m);
  if (code === 9) return key('tab', m);
  if (code === 27) return key('escape', m);
  if (code === 127 || code === 8) return key('backspace', m);
  if (code === 32) return key('space', m, ' ');
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return key('unknown', m);
  let ch = String.fromCodePoint(code);
  if (m.shift && /^[a-z]$/.test(ch)) ch = ch.toUpperCase();
  return key(ch, m, ch);
}

/** One byte below 0x20, or 0x7f. */
function controlKey(c: string): KeyEvent {
  const b = c.charCodeAt(0);
  if (c === '\r') return key('enter');
  // Control+J. Some terminals send it for Control+Enter.
  if (c === '\n') return key('enter', { ctrl: true });
  if (c === '\t') return key('tab');
  if (b === 0x7f) return key('backspace');
  if (b === 0x08) return key('backspace', { ctrl: true });
  if (b === 0) return key('space', { ctrl: true });
  if (b <= 0x1a) return key(String.fromCharCode(b + 96), { ctrl: true });
  return key(String.fromCharCode(b + 64), { ctrl: true });
}

export class Decoder {
  private buf = '';
  private paste: string | null = null;

  /** Whether part of a sequence waits for more bytes, so the caller should call flush() after a short pause. */
  get pending(): boolean {
    return this.buf.length > 0 && this.paste === null;
  }

  feed(chunk: string): InputEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  /** What is left, read as keys: a lone Escape, or Alt with the key after it. */
  flush(): InputEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): InputEvent[] {
    const out: InputEvent[] = [];
    for (;;) {
      if (this.paste !== null) {
        const end = this.buf.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a tail that may be the start of the end marker.
          const keep = Math.min(this.buf.length, PASTE_END.length - 1);
          let cut = this.buf.length;
          for (let k = keep; k > 0; k--) if (PASTE_END.startsWith(this.buf.slice(-k))) { cut = this.buf.length - k; break; }
          this.paste += this.buf.slice(0, cut);
          this.buf = this.buf.slice(cut);
          return out;
        }
        out.push({ type: 'paste', text: (this.paste + this.buf.slice(0, end)).replace(/\r\n?/g, '\n') });
        this.buf = this.buf.slice(end + PASTE_END.length);
        this.paste = null;
        continue;
      }
      if (!this.buf) return out;
      const s = this.buf;
      const c = s[0]!;
      if (c !== '\x1b') {
        if (c < ' ' || c === '\x7f') { out.push(controlKey(c)); this.buf = s.slice(1); continue; }
        // A run of printable text: one key per grapheme.
        let j = 0;
        while (j < s.length && s[j]! >= ' ' && s[j] !== '\x7f' && s[j] !== '\x1b') j++;
        for (const g of graphemes(s.slice(0, j))) out.push(key(g === ' ' ? 'space' : g, { shift: /^[A-Z]$/.test(g) }, g));
        this.buf = s.slice(j);
        continue;
      }
      if (s.length === 1) {
        if (!final) return out;
        out.push(key('escape'));
        this.buf = '';
        continue;
      }
      if (s[1] === '[') {
        const m = CSI.exec(s);
        if (!m) {
          if (CSI_PREFIX.test(s) && !final) return out;
          // Not a sequence this decoder knows: drop the escape and read the rest as keys.
          out.push(key('[', { alt: true }));
          this.buf = s.slice(2);
          continue;
        }
        this.buf = s.slice(m[0].length);
        const ev = this.csi(m[1]!, m[2]!, m[4]!);
        if (ev) out.push(ev);
        continue;
      }
      if (s[1] === 'O') {
        if (s.length === 2) { if (!final) return out; out.push(key('O', { alt: true, shift: true })); this.buf = ''; continue; }
        const name = LETTER[s[2]!];
        out.push(name ? key(name) : key(s[2]!, { alt: true }));
        this.buf = s.slice(3);
        continue;
      }
      if (s[1] === '\x1b') { out.push(key('escape')); this.buf = s.slice(1); continue; }
      // Escape and another key: Alt and that key.
      const next = graphemes(s.slice(1))[0] ?? '';
      const k = next < ' ' || next === '\x7f' ? controlKey(next) : key(next === ' ' ? 'space' : next, { shift: /^[A-Z]$/.test(next) });
      out.push({ ...k, alt: true, text: undefined });
      this.buf = s.slice(1 + next.length);
    }
  }

  private csi(prefix: string, params: string, final: string): InputEvent | undefined {
    const n = params.split(';').map((p) => (p === '' ? undefined : Number(p.split(':')[0])));
    if (prefix === '<' && (final === 'M' || final === 'm')) {
      const b = n[0] ?? 0;
      const x = (n[1] ?? 1) - 1;
      const y = (n[2] ?? 1) - 1;
      const m = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16) };
      const button = b & 3;
      if (b & 64) return { type: 'mouse', action: button === 0 ? 'wheel-up' : 'wheel-down', button: 0, x, y, ...m };
      if (b & 32) return { type: 'mouse', action: button === 3 ? 'move' : 'drag', button: button === 3 ? 0 : button, x, y, ...m };
      return { type: 'mouse', action: final === 'M' ? 'down' : 'up', button, x, y, ...m };
    }
    if (prefix === '?' && final === 'u') return { type: 'reply', kind: 'kitty', value: params };
    if (prefix === '?' && final === 'c') return { type: 'reply', kind: 'attributes', value: params };
    if (prefix) return undefined;
    // Kitty reports a key's release as event type 3, after a colon in the modifiers. The client reads presses only.
    if (/;\d+:3(;|$)/.test(params)) return undefined;
    if (final === 'I' && !params) return { type: 'focus', on: true };
    if (final === 'O' && !params) return { type: 'focus', on: false };
    if (final === 'Z') return key('tab', { shift: true });
    if (final === '~') {
      const code = n[0] ?? 0;
      if (code === 200) { this.paste = ''; return undefined; }
      if (code === 27 && n[2] !== undefined) return codeKey(n[2], mods(n[1]));
      const name = TILDE[code];
      return name ? key(name, mods(n[1])) : undefined;
    }
    if (final === 'u') {
      return codeKey(n[0] ?? 0, mods(n[1]));
    }
    const name = LETTER[final];
    return name ? key(name, mods(n[1])) : undefined;
  }
}
