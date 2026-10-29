// The terminal itself: the alternate screen, raw input, mouse reports, bracketed paste and focus reports, and putting
// all of it back on every way out, a crash included. The keyboard setup follows pi's terminal UI: ask for the kitty
// keyboard protocol and query it, and when the terminal does not answer, turn on xterm's modifyOtherKeys instead,
// so Ctrl+Enter reaches the client in every terminal that can send it.
import fs from 'node:fs';
import { Decoder, type InputEvent } from './input.ts';

const ENTER = [
  '\x1b[?1049h', // the alternate screen
  '\x1b[?7l', // no wrap at the right edge, so the last column can hold a character
  '\x1b[?25l', // no hardware cursor: fields draw their own
  '\x1b[?1000h\x1b[?1002h\x1b[?1006h', // mouse presses, drags and the wheel, in SGR form
  '\x1b[?2004h', // bracketed paste
  '\x1b[?1004h', // focus in and out
  '\x1b[>1u', // the kitty keyboard protocol, flag 1: keys with modifiers are told apart
  '\x1b[?u\x1b[c', // which keyboard protocol is on; the device attributes answer last
].join('');
const LEAVE = '\x1b[<u\x1b[>4;0m\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?7h\x1b[?1049l';

export interface TerminalIo {
  input: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown; isTTY?: boolean };
  output: NodeJS.WritableStream & { columns?: number; rows?: number; isTTY?: boolean; fd?: number };
}

export class Terminal {
  private io: TerminalIo;
  private decoder = new Decoder();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private kitty = false;
  private restoreHandlers: (() => void)[] = [];
  /** A size from YOUR_ATTENTION_TUI_SIZE, such as 100x40, for a terminal that does not report one. */
  private fixed: { cols: number; rows: number } | undefined;
  onInput: (ev: InputEvent) => void = () => {};
  onResize: () => void = () => {};

  constructor(io: TerminalIo, size?: string) {
    this.io = io;
    const m = /^(\d+)x(\d+)$/.exec(size ?? '');
    if (m) this.fixed = { cols: Number(m[1]), rows: Number(m[2]) };
  }

  get cols(): number {
    return this.io.output.columns || this.fixed?.cols || 80;
  }

  get rows(): number {
    return this.io.output.rows || this.fixed?.rows || 24;
  }

  write(s: string): void {
    if (s) this.io.output.write(s);
  }

  /** Take over the screen. Every way out of the process puts the terminal back. */
  start(): void {
    this.active = true;
    this.io.input.setRawMode?.(true);
    this.io.input.resume();
    (this.io.input as NodeJS.ReadableStream & { setEncoding?: (e: string) => void }).setEncoding?.('utf8');
    this.io.input.on('data', this.data);
    this.write(ENTER);
    const resize = () => this.onResize();
    this.io.output.on('resize', resize);
    const restore = () => this.stop();
    const crash = (e: unknown) => {
      this.stop();
      process.stderr.write(`your-attention tui stopped: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exit(1);
    };
    const signal = (sig: NodeJS.Signals) => () => { this.stop(); process.exit(sig === 'SIGINT' ? 130 : 143); };
    const onInt = signal('SIGINT');
    const onTerm = signal('SIGTERM');
    const onHup = signal('SIGHUP');
    process.on('exit', restore);
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    this.restoreHandlers.push(() => {
      this.io.output.off('resize', resize);
      process.off('exit', restore);
      process.off('uncaughtException', crash);
      process.off('unhandledRejection', crash);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
    });
  }

  /** Put the terminal back as it was. Safe to call twice. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.flushTimer);
    this.io.input.off('data', this.data);
    // Written at once, so a crash or exit cannot leave the terminal in mouse mode.
    const fd = this.io.output.fd;
    try { if (typeof fd === 'number') fs.writeSync(fd, LEAVE); else this.io.output.write(LEAVE); } catch { this.io.output.write(LEAVE); }
    this.io.input.setRawMode?.(false);
    this.io.input.pause();
    for (const h of this.restoreHandlers.splice(0)) h();
  }

  /** Hand the terminal back for Ctrl+Z, and take it again when the shell resumes the client. */
  suspend(onResume: () => void): void {
    if (process.platform === 'win32') return;
    this.stop();
    process.once('SIGCONT', () => { this.start(); onResume(); });
    process.kill(process.pid, 'SIGTSTP');
  }

  private data = (chunk: string | Buffer): void => {
    clearTimeout(this.flushTimer);
    for (const ev of this.decoder.feed(String(chunk))) this.event(ev);
    // A lone Escape, or a sequence cut short, waits a moment for the rest.
    if (this.decoder.pending) this.flushTimer = setTimeout(() => { for (const ev of this.decoder.flush()) this.event(ev); }, 30);
  };

  private event(ev: InputEvent): void {
    if (ev.type === 'reply') {
      if (ev.kind === 'kitty') this.kitty = true;
      // The device attributes come after the kitty answer, when there is one. Without it, use modifyOtherKeys.
      else if (!this.kitty) this.write('\x1b[>4;2m');
      return;
    }
    this.onInput(ev);
  }
}
