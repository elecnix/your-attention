// The notice that a card changed hands, between a real inbox and the client: the inbox sends it to each connection
// until the session acknowledges it, and the client lets a copy through when it could not get the notice acknowledged.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

type Notice = Extract<AgentEvent, { type: 'reassigned' }>;
const notices = (events: AgentEvent[], card: string): Notice[] => events.filter((e): e is Notice => e.type === 'reassigned' && e.card.id === card);

describe('the notice of a card that changed hands', () => {
  it('reaches the handler again on the next connection when its acknowledgment failed', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    await client.post({ id: 'rn-1', agent: 'claude:child', title: 'Which schema?' });
    assert.equal((await h.owner('POST', '/v1/cards/rn-1/reassign', { to: 'claude:parent', why: 'child retired' })).status, 200);
    const first = h.listen(client, 'claude:parent');
    const [notice] = await until(() => { const n = notices(first.events, 'rn-1'); return n.length ? n : undefined; });
    first.stop();
    await first.ended;
    // The acknowledgment fails, as when the inbox is out of reach for that one request.
    const call = (client as unknown as { call: unknown }).call;
    (client as unknown as { call: () => Promise<never> }).call = () => Promise.reject(new Error('the inbox is out of reach'));
    await assert.rejects(client.ackNotice(notice!), /out of reach/);
    (client as unknown as { call: unknown }).call = call;
    // The inbox still waits for the acknowledgment, so the next connection brings the notice, and the client lets it through.
    const second = h.listen(client, 'claude:parent');
    const [again] = await until(() => { const n = notices(second.events, 'rn-1'); return n.length ? n : undefined; });
    await client.ackNotice(again!);
    second.stop();
    await second.ended;
    // Once acknowledged, a connection hears nothing more of it.
    const third = h.listen(new Client({ url: h.server.url, token: h.agentToken }), 'claude:parent');
    await until(() => third.events.find((e) => e.type === 'hello'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(notices(third.events, 'rn-1').length, 0);
    third.stop();
  });

  it('drops a second copy of a notice the handler already has, while its acknowledgment is still to come', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    await client.post({ id: 'rn-2', agent: 'claude:child', title: 'Which port?' });
    await h.owner('POST', '/v1/cards/rn-2/reassign', { to: 'claude:parent2', why: 'child retired' });
    const first = h.listen(client, 'claude:parent2');
    await until(() => notices(first.events, 'rn-2')[0]);
    first.stop();
    await first.ended;
    const second = h.listen(client, 'claude:parent2');
    await until(() => second.events.find((e) => e.type === 'hello'));
    // The inbox sends a waiting notice right after the hello, so a short wait lets a copy arrive if the client kept it.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(notices(second.events, 'rn-2').length, 0, 'the inbox sent the copy, and the client dropped it');
    second.stop();
  });
});
