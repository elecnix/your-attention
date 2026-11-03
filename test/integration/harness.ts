// Starts a real inbox in a temporary home for one test file.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '../../src/client.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { serve, type RunningServer } from '../../src/node/server.ts';

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

export async function start(): Promise<Harness> {
  const streams = new Set<AbortController>();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'your-attention-'));
  const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report', blocked: 'a test inbox sends nothing' } });
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
  close(): void;
}

export const CLI_ARGS = [path.join(ROOT, 'src', 'cli.ts')];

/** Start `your-attention serve` as its own process in a temporary home, which is what tests of the CLI itself need. */
export async function serveForTest(prefix = 'ya-cli-'): Promise<CliServer> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const yaHome = path.join(home, '.your-attention');
  const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: yaHome };
  const serve: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...CLI_ARGS, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
  // Right after the spawn: a failed spawn emits `error` on the next tick, which would otherwise kill the test process
  // before the cleanup below exists.
  serve.on('error', () => {});
  const file = path.join(yaHome, 'server.json');
  let url = '';
  try {
    // A server that fails to boot leaves no address, and this waits a few seconds for one. Either way the child and its
    // home must go, or a failed start leaks both for the rest of the run.
    ({ url } = await until(() => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string } : undefined)));
  } catch (e) {
    serve.kill();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    throw e;
  }
  return {
    home,
    url,
    env,
    read: (f) => fs.readFileSync(path.join(yaHome, f), 'utf8').trim(),
    call: (token, method, route, body) => callAt(url, token, method, route, body),
    close: () => {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
