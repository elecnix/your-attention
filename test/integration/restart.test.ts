// A session that restarts gets the answers its earlier process received but never read.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { AgentEvent } from '../../src/core/types.ts';
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
