// A real inbox for one spec file, and helpers to act as agents on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { Client } from '../../src/client.ts';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { serve, type RunningServer } from '../../src/node/server.ts';

export interface TestInbox {
  server: RunningServer;
  agent: Client;
  home: string;
  /** Open the page signed in, as the owner. */
  open(page: Page): Promise<void>;
  state(): Promise<{ cards: Card[]; states: Record<string, string>; answers: Record<string, { values: Record<string, unknown>; comment: string }> }>;
  /** Receive answers for one agent, into a list the test reads. */
  listen(agentId: string): { events: AgentEvent[]; stop(): void };
  close(): Promise<void>;
}

export async function startInbox(): Promise<TestInbox> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-browser-'));
  const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {} });
  const agent = new Client({ url: server.url, token: fs.readFileSync(path.join(home, 'agent-token'), 'utf8').trim() });
  const stops: (() => void)[] = [];
  return {
    server,
    agent,
    home,
    async open(page) {
      await page.goto(`${server.url}/#token=${server.ownerToken}`);
      await page.locator('.bar .pill.on').waitFor();
    },
    async state() {
      return (await (await fetch(`${server.url}/v1/state`, { headers: { authorization: `Bearer ${server.ownerToken}` } })).json()) as Awaited<ReturnType<TestInbox['state']>>;
    },
    listen(agentId) {
      const events: AgentEvent[] = [];
      const ctl = new AbortController();
      void agent.stream(agentId, (e) => { events.push(e); }, ctl.signal);
      stops.push(() => ctl.abort());
      return { events, stop: () => ctl.abort() };
    },
    async close() {
      for (const s of stops) s();
      await server.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
