// A session that restarts gets the answers its earlier process received but never read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { serve } from '../../src/node/server.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

const listen = (transport: 'auto' | 'sse' | 'poll') => {
  const client = new Client({ url: h.server.url, token: h.agentToken });
  const got: AgentEvent[] = [];
  const stop = new AbortController();
  void client.stream('restarting', (ev) => { got.push(ev); }, stop.signal, transport);
  return { client, got, stop };
};

describe('an agent that restarts', () => {
  for (const transport of ['auto', 'sse', 'poll'] as const) {
    it(`gets the unread answer again over ${transport}, once`, async () => {
      const first = listen(transport);
      const id = `restart-${transport}`;
      await first.client.post({ id, agent: 'restarting', title: `Still there over ${transport}?` });
      await until(async () => ((await (await h.owner('GET', '/v1/state')).json()) as { presence: Record<string, { online: boolean }> }).presence?.['restarting']?.online || undefined);
      await h.owner('POST', `/v1/cards/${id}/answer`, { values: { choice: 'o1' } });
      await until(() => first.got.find((e) => e.type === 'answer' && e.card.id === id));
      first.stop.abort();
      const second = listen(transport);
      await until(() => second.got.find((e) => e.type === 'answer' && e.card.id === id));
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(second.got.filter((e) => e.type === 'answer' && e.card.id === id).length, 1);
      await second.client.ack(id);
      second.stop.abort();
    });
  }
});

describe('an agent whose inbox restarts', () => {
  it('comes back online over its WebSocket once the inbox is up again', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'your-attention-'));
    const opts = { host: '127.0.0.1', home, mdns: false, watch: false, log: () => {} };
    let server = await serve({ ...opts, port: 0 });
    const port = server.port;
    const online = async () => ((await (await fetch(`${server.url}/v1/state`, { headers: { authorization: `Bearer ${server.ownerToken}` } })).json()) as { presence: Record<string, { online: boolean }> }).presence['comeback']?.online || undefined;
    // Count the sockets that open, to tell a WebSocket reconnect from a fallback to server-sent events.
    let opened = 0;
    const Native = globalThis.WebSocket;
    globalThis.WebSocket = class extends Native {
      constructor(...a: ConstructorParameters<typeof Native>) { super(...a); this.addEventListener('open', () => { opened++; }); }
    };
    const stop = new AbortController();
    try {
      void new Client({ url: server.url, token: fs.readFileSync(path.join(home, 'agent-token'), 'utf8').trim() }).stream('comeback', () => {}, stop.signal);
      await until(online);
      await server.close();
      // Long enough for the client to try the link while nothing listens on it.
      await new Promise((r) => setTimeout(r, 1500));
      server = await serve({ ...opts, port });
      await until(online, 8000);
      assert.equal(opened, 2);
    } finally {
      stop.abort();
      globalThis.WebSocket = Native;
      await server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
