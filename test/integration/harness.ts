// Starts a real inbox in a temporary home for one test file.
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
