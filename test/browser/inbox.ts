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
  /** The whole cards and answers, as the inbox stores them. The page reads summaries from GET /v1/state, and each card it opens. */
  state(): Promise<{ cards: Card[]; states: Record<string, string>; answers: Record<string, { values: Record<string, unknown>; comment: string }> }>;
  /** Receive answers for one agent, into a list the test reads. */
  listen(agentId: string): { events: AgentEvent[]; stop(): void };
  close(): Promise<void>;
}

/** A test inbox sends no usage counts and shows no notice, unless a test passes `usage` to check them.
 * It never offers to set a PIN, unless a test passes `pinPrompt` to check the offer. */
export async function startInbox(opts: { usage?: boolean; pinPrompt?: boolean } = {}): Promise<TestInbox> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-browser-'));
  const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report', ...(opts.usage ? {} : { blocked: 'a test inbox sends nothing' }) } });
  if (!opts.pinPrompt) server.inbox.pin.setNeverAsk(true);
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
      return server.inbox.state() as unknown as Awaited<ReturnType<TestInbox['state']>>;
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
