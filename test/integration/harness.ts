// Starts a real inbox in a temporary home for one test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve, type RunningServer } from '../../src/node/server.ts';

export interface Harness {
  home: string;
  server: RunningServer;
  agentToken: string;
  /** Call the inbox as the owner, the way the page does. */
  owner(method: string, route: string, body?: unknown): Promise<Response>;
  stop(): Promise<void>;
}

export async function start(): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'your-attention-'));
  const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {} });
  const h: Harness = {
    home,
    server,
    agentToken: fs.readFileSync(path.join(home, 'agent-token'), 'utf8').trim(),
    owner: (method, route, body) => fetch(`${h.server.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${h.server.ownerToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    async stop() {
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
