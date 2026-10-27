// Runs the triage service against a real inbox, with a judge that returns cards without a recommendation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { runTriage } from '../../src/extensions/triage.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
const stop = new AbortController();
let judged = 0;
before(async () => { h = await start(); });
after(async () => { stop.abort(); await h.stop(); });

const state = async () => (await (await h.owner('GET', '/v1/state')).json()) as { cards: Card[]; states: Record<string, string> };

describe('the triage service', () => {
  it('lets cards through while it is down, then screens them when it connects', async () => {
    const agent = new Client({ url: h.server.url, token: h.agentToken });
    await agent.post({ id: 'early', agent: 's1', title: 'Rename the flag?' });
    assert.equal((await state()).states['early'], 'open');
    const token = fs.readFileSync(path.join(h.home, 'extension-token'), 'utf8').trim();
    void runTriage({
      url: h.server.url, token, log: () => {},
      judge: async (prompt) => { judged++; return prompt.includes('"recommendation": "') ? '{"verdict":"pass"}' : '{"verdict":"return","reason":"Say what you recommend."}'; },
    }, stop.signal);
    await until(async () => (await state()).states['early'] === 'closed' || undefined);
    assert.equal((await state()).cards.find((c) => c.id === 'early')?.closed?.kind, 'returned');
  });

  it('passes a card with a recommendation, and tells the agent about a returned one', async () => {
    const agent = new Client({ url: h.server.url, token: h.agentToken });
    const got: AgentEvent[] = [];
    const s = new AbortController();
    void agent.stream('s2', (e) => { got.push(e); }, s.signal);
    await agent.post({ id: 'good', agent: 's2', title: 'Ship today?', recommendation: 'Yes, tests pass.' });
    await agent.post({ id: 'bad', agent: 's2', title: 'Ship today?' });
    await until(async () => { const st = (await state()).states; return st['good'] === 'open' && st['bad'] === 'closed' || undefined; });
    const ev = await until(() => got.find((e) => e.type === 'returned'));
    assert.equal(ev.type === 'returned' && ev.reason, 'Say what you recommend.');
    s.abort();
    assert.ok(judged >= 3);
  });
});
