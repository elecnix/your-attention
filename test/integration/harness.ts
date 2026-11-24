// Starts a real inbox in a temporary home for one test file.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Client } from '../../src/client.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { serve, type RunningServer, type ServeOptions } from '../../src/node/server.ts';

export interface Harness {
  home: string;
  server: RunningServer;
  agentToken: string;
  /** Call the inbox as the owner, the way the page does. */
  owner(method: string, route: string, body?: unknown): Promise<Response>;
  /** The whole cards and answers, as the inbox stores them. GET /v1/state sends summaries, which a test of a card's content can't read. */
  stored(): Promise<ReturnType<RunningServer['inbox']['state']>>;
  /** Receive one agent's events into a list. `stop` ends the stream, and so does stopping the inbox, even after a failed test:
   * a client stream retries a gone inbox forever, so one left open keeps the test process alive. */
  listen(client: Client, agent: string): { events: AgentEvent[]; stop(): void; ended: Promise<void> };
  stop(): Promise<void>;
}

export async function start(extra: Partial<ServeOptions> = {}): Promise<Harness> {
  const streams = new Set<AbortController>();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'your-attention-'));
  const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report', blocked: 'a test inbox sends nothing' }, ...extra });
  const h: Harness = {
    home,
    server,
    agentToken: fs.readFileSync(path.join(home, 'agent-token'), 'utf8').trim(),
    owner: (method, route, body) => fetch(`${h.server.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${h.server.ownerToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    stored: async () => h.server.inbox.state(),
    listen(client, agent) {
      const events: AgentEvent[] = [];
      const ctl = new AbortController();
      streams.add(ctl);
      const ended = client.stream(agent, (e) => { events.push(e); }, ctl.signal);
      return { events, stop: () => { ctl.abort(); streams.delete(ctl); }, ended };
    },
    async stop() {
      for (const ctl of streams) ctl.abort();
      streams.clear();
      await h.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return h;
}

/** Wait until `check` returns a value, or fail after `ms`. */
export async function until<T>(check: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Run one Claude Code hook as its own process, as Claude Code runs it, and give its exit code and one captured stream.
 * The inbox lives in the test process, so the spawn must not block. `capture` defaults to stdout, where a PreToolUse
 * deny is written; `stderr` reads a hook that logs, and the other stream is inherited. */
export function runHook(h: Harness, mode: string, input: Record<string, unknown>, opts: { env?: Record<string, string>; capture?: 'stdout' | 'stderr' } = {}): Promise<{ status: number | null; out: string }> {
  const capture = opts.capture ?? 'stdout';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-hook', mode], {
      env: { ...process.env, YOUR_ATTENTION_HOME: h.home, YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken, ...opts.env },
      stdio: ['pipe', capture === 'stdout' ? 'pipe' : 'ignore', capture === 'stderr' ? 'pipe' : 'inherit'],
    });
    let out = '';
    const stream = capture === 'stdout' ? child.stdout! : child.stderr!;
    stream.on('data', (d) => { out += String(d); });
    // A spawn that fails, such as EAGAIN on a loaded box, rejects this test instead of throwing out of the whole file.
    child.on('error', reject);
    // `close` follows the exit and the closed stdio streams, so the last chunk of a hook's output is in `out`.
    child.on('close', (status) => resolve({ status, out }));
    child.stdin!.end(JSON.stringify(input));
  });
}

/** Read one file of the inbox home, trimmed, or undefined when it is not there. */
export function homeFile(h: Harness, name: string): string | undefined {
  try { return fs.readFileSync(path.join(h.home, name), 'utf8').trim(); } catch { return undefined; }
}

/** Stop a process this test spawned, and remove its home once the process has let go of the files in it. A Windows
 * process holds its SQLite file until it exits, so a delete right after the kill fails with EBUSY. */
export async function stopAndRemove(child: ChildProcess, home: string): Promise<void> {
  const exited = new Promise<void>((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', () => r()); });
  child.kill();
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5000))]);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Call one route of a test inbox as the token's owner or agent. */
export function callAt(url: string, token: string, method: string, route: string, body?: unknown): Promise<Response> {
  // A body is sent whenever one is given: `0`, `''`, `false` and `null` are bodies a route may want, not absences.
  return fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export interface CliServer {
  home: string;
  url: string;
  /** The environment a CLI run in this home needs, so the command talks to this inbox. */
  env: NodeJS.ProcessEnv;
  /** A file the inbox wrote in its home, trimmed. */
  read(file: string): string;
  call(token: string, method: string, route: string, body?: unknown): Promise<Response>;
  close(): Promise<void>;
}

export const CLI_ARGS = [path.join(ROOT, 'src', 'cli.ts')];

/** Run the CLI once to its end in `env`, and give its exit code with what it printed. A failure resolves too, so a test
 * asserts on the code. */
export function runCli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', ...CLI_ARGS, ...args], { env, encoding: 'utf8' })
    .then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);
}

/** Start `your-attention serve` as its own process in a temporary home, which is what tests of the CLI itself need. */
export async function serveForTest(prefix = 'ya-cli-'): Promise<CliServer> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const yaHome = path.join(home, '.your-attention');
  const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: yaHome };
  // The environment wins over every file, so a developer's own variables would send these commands at their real inbox
  // instead of the one this test started.
  delete (env as Record<string, string | undefined>)['YOUR_ATTENTION_URL'];
  delete (env as Record<string, string | undefined>)['YOUR_ATTENTION_TOKEN'];
  // A test inbox takes its place from the home it is given, never from the herdr session that runs the tests: a card
  // posted here must not ask herdr about the developer's own pane.
  for (const k of Object.keys(env)) if (k.startsWith('HERDR_')) delete (env as Record<string, string | undefined>)[k];
  const serve: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...CLI_ARGS, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
  // Right after the spawn: a failed spawn emits `error` on the next tick, which would otherwise kill the test process
  // before the cleanup below exists.
  serve.on('error', () => {});
  const file = path.join(yaHome, 'server.json');
  let url = '';
  try {
    // A server that fails to boot leaves no address, and this waits a few seconds for one. Either way the child and its
    // home must go, or a failed start leaks both for the rest of the run.
    ({ url } = await until(() => {
      if (!fs.existsSync(file)) return undefined;
      // The server creates the file and writes it in two steps, so a reader can catch it empty. That is a fact about
      // this wait, not about the server: the next poll reads the whole file.
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string };
      } catch {
        return undefined;
      }
    }));
  } catch (e) {
    await stopAndRemove(serve, home);
    throw e;
  }
  return {
    home,
    url,
    env,
    read: (f) => fs.readFileSync(path.join(yaHome, f), 'utf8').trim(),
    call: (token, method, route, body) => callAt(url, token, method, route, body),
    close: () => stopAndRemove(serve, home),
  };
}
