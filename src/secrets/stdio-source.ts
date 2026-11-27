// The stdio form of a secret source: an executable this process starts in the source's folder and talks to with one
// JSON message per line, version 1. SPEC.md#secret-sources holds the contract.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { isSealed } from '../core/sealed.ts';
import type { SourceCandidate } from '../core/secret-sources.ts';
import type { Sealed } from '../core/types.ts';
import { SOURCE_CALL_TIMEOUT_MS, SOURCE_PROTOCOL_VERSION, type Detected, type SecretSource, type SourceRequest } from './source.ts';

export interface StdioOptions {
  /** The source's name, which its log lines and its errors carry. */
  name: string;
  /** The origin's folder, where the command starts. */
  folder: string;
  /** The executable and its arguments. A path with a slash is relative to the folder, and `node` is this Node. */
  command: string[];
  /** The entry's settings, which the source reads as JSON from YOUR_ATTENTION_SOURCE_SETTINGS. */
  settings?: Record<string, unknown>;
  timeoutMs?: number;
  /** How long a stopped source has to exit after SIGTERM before SIGKILL ends it, 2 seconds by default. */
  killGraceMs?: number;
  /** Where each line of the source's stderr goes, after its name. */
  log?: (line: string) => void;
}

/** The variable a stdio source reads its settings from. */
export const SETTINGS_ENV = 'YOUR_ATTENTION_SOURCE_SETTINGS';

type Reply = Record<string, unknown>;
/** A request without the version and the id, which each call adds. */
type Call<R = SourceRequest> = R extends unknown ? Omit<R, 'v' | 'id'> : never;
/** A call waiting for its reply, from the process it went to. */
interface Pending { running: ChildProcess; resolve(r: Reply): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

/** A stdio source. It starts on the first call, and again on the call after a failure. `stop` ends the process. */
export function stdioSource(options: StdioOptions): SecretSource & { stop(): void } {
  const { name, folder } = options;
  const timeoutMs = options.timeoutMs ?? SOURCE_CALL_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? 2000;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let child: ChildProcess | undefined;
  let next = 0;
  const pending = new Map<string, Pending>();

  const alive = (running: ChildProcess): boolean => running.exitCode === null && running.signalCode === null;

  /** Take a process out of service, so the next call starts a new one. Calls it already owes still wait for it. */
  function detach(running: ChildProcess): void {
    if (child === running) child = undefined;
  }

  /** End the process and fail every call it owes, so the next call starts it again. */
  function fault(running: ChildProcess, reason: string): void {
    detach(running);
    if (alive(running) && !running.killed) {
      running.kill();
      // A source that traps SIGTERM would outlive its handle, and the next call would start a second copy beside it.
      // This timer keeps the process alive until the source is gone, so a short command such as `secret source list`
      // can't end first and leave the source running. The exit clears it.
      const force = setTimeout(() => { if (alive(running)) running.kill('SIGKILL'); }, killGraceMs);
      running.once('exit', () => clearTimeout(force));
    }
    const error = new Error(`the source ${name} ${reason}`);
    for (const [id, p] of pending) {
      if (p.running !== running) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(error);
    }
  }

  function start(): ChildProcess {
    const [first = '', ...args] = options.command;
    const executable = first === 'node' ? process.execPath : first.includes('/') ? path.resolve(folder, first) : first;
    // The source gets this machine's environment without the inbox's own token.
    const env: NodeJS.ProcessEnv = { ...process.env, [SETTINGS_ENV]: JSON.stringify(options.settings ?? {}) };
    delete env['YOUR_ATTENTION_TOKEN'];
    const running = spawn(executable, args, { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'] });
    running.on('error', (e: NodeJS.ErrnoException) => fault(running, e.code === 'ENOENT' ? `could not start: ${first} was not found` : `could not start: ${e.message}`));
    // At the exit, no new call goes to this process. Its calls fail only at 'close', which comes after stdout has
    // ended, so a reply written just before the exit still reaches the handler below.
    running.on('exit', () => detach(running));
    running.on('close', (code, signal) => fault(running, `stopped (${signal ?? `exit ${code}`})`));
    running.stdin?.on('error', () => { /* the exit reports it */ });
    readline.createInterface({ input: running.stdout! }).on('line', (line) => {
      let reply: Reply;
      try { reply = JSON.parse(line) as Reply; } catch { return fault(running, 'answered a line that is not JSON'); }
      if (!reply || typeof reply !== 'object' || reply['v'] !== SOURCE_PROTOCOL_VERSION) return fault(running, `answered with a version other than ${SOURCE_PROTOCOL_VERSION}`);
      const id = String(reply['id']);
      const p = pending.get(id);
      if (!p || p.running !== running) return;
      pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(reply);
    });
    readline.createInterface({ input: running.stderr! }).on('line', (line) => log(`[${name}] ${line}`));
    // A source waiting for its next call keeps nothing alive: a pending call has its timer for that.
    running.unref();
    for (const s of [running.stdin, running.stdout, running.stderr]) (s as unknown as { unref?(): void } | null)?.unref?.();
    return running;
  }

  function call(request: Call): Promise<Reply> {
    child ??= start();
    const running = child;
    const id = String(++next);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => fault(running, `did not answer within ${Math.round(timeoutMs / 1000) || timeoutMs / 1000} seconds`), timeoutMs);
      pending.set(id, { running, resolve, reject, timer });
      running.stdin?.write(`${JSON.stringify({ v: SOURCE_PROTOCOL_VERSION, id, ...request })}\n`);
    }).then((reply) => {
      if (typeof reply['error'] === 'string') throw new Error(reply['error']);
      return reply;
    });
  }

  /** The field of a reply that a call answers, or a sentence that names what the reply lacked. */
  async function field<T>(request: Call, key: string, what: string, valid: (v: unknown) => v is T): Promise<T> {
    const r = await call(request);
    if (!valid(r[key])) throw new Error(`the source ${name} answered ${request.call} without ${what}`);
    return r[key];
  }

  return {
    async detect(): Promise<Detected> {
      const r = await call({ call: 'detect' });
      if (r['status'] === 'ready') return { status: 'ready' };
      if (r['status'] === 'off') return { status: 'off', reason: typeof r['reason'] === 'string' ? r['reason'] : 'the source is off' };
      throw new Error(`the source ${name} answered detect without a status`);
    },
    lookup: (query) => field({ call: 'lookup', query }, 'candidates', 'candidates', (v): v is SourceCandidate[] => Array.isArray(v)),
    // A source answers only a sealed value: a plain one would cross this process in the clear.
    release: (candidate, publicKey) => field({ call: 'release', candidate, publicKey }, 'sealed', 'a sealed value', isSealed),
    stop() {
      if (child) fault(child, 'was stopped');
    },
  };
}
