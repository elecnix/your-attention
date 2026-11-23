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

const state = async () => (await h.stored()) as { cards: Card[]; states: Record<string, string> };

describe('the triage service', () => {
  it('leaves a card that arrived before it first connected alone', async () => {
    const agent = new Client({ url: h.server.url, token: h.agentToken });
    await agent.post({ id: 'early', agent: 's1', title: 'Rename the flag?' });
    assert.equal((await state()).states['early'], 'open');
    const token = fs.readFileSync(path.join(h.home, 'extension-token'), 'utf8').trim();
    let connected: () => void = () => {};
    const up = new Promise<void>((resolve) => { connected = resolve; });
    void runTriage({
      url: h.server.url, token, log: (...a: unknown[]) => { if (a[0] === 'connected to') connected(); },
      judge: async (prompt) => { judged++; return prompt.includes('"recommendation": "') ? '{"verdict":"pass"}' : '{"verdict":"return","reason":"Say what you recommend."}'; },
    }, stop.signal);
    await up;
    assert.equal((await state()).cards.find((c) => c.id === 'early')?.triage?.state, 'skipped');
    assert.equal((await state()).states['early'], 'open');
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
    // One call for the card with a recommendation, and one for the card without.
    assert.ok(judged >= 2);
  });

  it('screens the cards that were there before it connected when the person asks for them', async () => {
    const token = fs.readFileSync(path.join(h.home, 'extension-token'), 'utf8').trim();
    const backlog = new AbortController();
    void runTriage({
      url: h.server.url, token, name: 'triage-backlog', screen: 'open', log: () => {},
      judge: async () => '{"verdict":"return","reason":"Say what you recommend."}',
    }, backlog.signal);
    await until(async () => (await state()).states['early'] === 'closed' || undefined);
    assert.equal((await state()).cards.find((c) => c.id === 'early')?.closed?.kind, 'returned');
    backlog.abort();
  });
});
