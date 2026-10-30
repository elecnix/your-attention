// Runs `your-attention tui` in a pseudo-terminal from `script`, feeds it keys and mouse reports, and keeps the screen it
// draws in a test emulator. On Windows, which has no `script`, the client runs on pipes with a fixed size instead.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vt } from '../vt.ts';
import { ROOT, until } from './harness.ts';

export interface Tui {
  vt: Vt;
  child: ChildProcess;
  trace: string;
  /** Send bytes to the client as the terminal would. */
  send(data: string): void;
  /** A left click at a zero-based column and row. */
  click(x: number, y: number): void;
  /** Wait until the screen shows `text`, and return where. */
  waitFor(text: string, ms?: number): Promise<{ x: number; y: number }>;
  /** The client's trace: one record per line. */
  events(): { event: string; ms: number; [k: string]: unknown }[];
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function startTui(opts: { url: string; token: string; cols?: number; rows?: number; env?: Record<string, string>; args?: string[] }): Tui {
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 40;
  const trace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ya-tui-')), 'trace.jsonl');
  const env = {
    ...process.env,
    YOUR_ATTENTION_URL: opts.url,
    YOUR_ATTENTION_TOKEN: opts.token,
    YOUR_ATTENTION_TUI_TRACE: trace,
    YOUR_ATTENTION_TUI_SIZE: `${cols}x${rows}`,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    COLORTERM: '',
    ...opts.env,
  };
  const node = [process.execPath, '--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'tui', ...(opts.args ?? [])].map(quote).join(' ');
  const inner = `stty cols ${cols} rows ${rows}; exec ${node}`;
  let child: ChildProcess;
  if (process.platform === 'darwin') child = spawn('sh', ['-c', 'cat | script -q /dev/null sh -c "$0"', inner], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  else if (process.platform === 'linux') child = spawn('sh', ['-c', 'cat | script -qfec "$0" /dev/null', inner], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  else child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'tui', ...(opts.args ?? [])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const vt = new Vt(cols, rows);
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => vt.write(d));
  child.stderr!.on('data', (d) => { stderr += String(d); });
  // A write to a client that already quit fails later, as an error on its input. On Windows the client reads that pipe
  // itself, so the Ctrl+C that stop() sends after a quit would throw from outside the test.
  child.stdin!.on('error', () => {});
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  let stopped: Promise<void> | undefined;
  const t: Tui = {
    vt,
    child,
    trace,
    send: (data) => { child.stdin!.write(data); },
    click: (x, y) => { child.stdin!.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`); },
    waitFor: (text, ms = 8000) => until(() => vt.find(text), ms).catch(() => { throw new Error(`the screen never showed "${text}":\n${vt.text()}\n${stderr}`); }),
    events: () => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; ms: number }) : []),
    exited,
    // A test stops its own client, and afterEach stops it again in case the test failed first.
    stop: () => (stopped ??= stop()),
  };
  async function stop(): Promise<void> {
    const start = t.events().find((e) => e.event === 'start') as { pid?: number } | undefined;
    if (child.exitCode === null) {
      child.stdin!.write('\x03');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    if (start?.pid) { try { process.kill(start.pid, 'SIGTERM'); } catch { /* already gone */ } }
    child.stdin!.end();
    child.stdout!.destroy();
    child.stderr!.destroy();
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    fs.rmSync(path.dirname(trace), { recursive: true, force: true });
  }
  return t;
}
