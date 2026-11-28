// A card the person sends to an agent, between a real inbox and the client: the inbox sends it to each connection until
// the session acknowledges it, and the client lets a copy through when it could not get the card acknowledged.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { AgentEvent, SentCard } from '../../src/core/types.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

type Sent = Extract<AgentEvent, { type: 'card' }>;
const sentCards = (events: AgentEvent[], id: string): Sent[] => events.filter((e): e is Sent => e.type === 'card' && e.id === id);
const send = async (agent: string, text: string): Promise<SentCard> => (await (await h.owner('POST', '/v1/send', { agent, text })).json()) as SentCard;

describe('a card the person sends to an agent', () => {
  it('reaches the handler again on the next connection when its acknowledgment failed, and never after one succeeded', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const sent = await send('claude:sc-1', 'Please rebase on main.');
    const first = h.listen(client, 'claude:sc-1');
    const [card] = await until(() => { const n = sentCards(first.events, sent.id); return n.length ? n : undefined; });
    first.stop();
    await first.ended;
    // The acknowledgment fails, as when the inbox is out of reach for that one request.
    const call = (client as unknown as { call: unknown }).call;
    (client as unknown as { call: () => Promise<never> }).call = () => Promise.reject(new Error('the inbox is out of reach'));
    await assert.rejects(client.ackSent(card!), /out of reach/);
    (client as unknown as { call: unknown }).call = call;
    assert.equal(h.server.inbox.sent(sent.id)?.readAt, null);
    // The inbox still waits for the acknowledgment, so the next connection brings the card, and the client lets it through.
    const second = h.listen(client, 'claude:sc-1');
    const [again] = await until(() => { const n = sentCards(second.events, sent.id); return n.length ? n : undefined; });
    await client.ackSent(again!);
    second.stop();
    await second.ended;
    assert.equal(typeof h.server.inbox.sent(sent.id)?.readAt, 'number');
    // Once acknowledged, a connection hears nothing more of it.
    const third = h.listen(new Client({ url: h.server.url, token: h.agentToken }), 'claude:sc-1');
    await until(() => third.events.find((e) => e.type === 'hello'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sentCards(third.events, sent.id).length, 0);
    third.stop();
  });

  it('drops a second copy of a card the handler already has, while its acknowledgment is still to come', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const sent = await send('claude:sc-2', 'Which port?');
    const first = h.listen(client, 'claude:sc-2');
    await until(() => sentCards(first.events, sent.id)[0]);
    first.stop();
    await first.ended;
    const second = h.listen(client, 'claude:sc-2');
    await until(() => second.events.find((e) => e.type === 'hello'));
    // The inbox sends a waiting card right after the hello, so a short wait lets a copy arrive if the client kept it.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sentCards(second.events, sent.id).length, 0, 'the inbox sent the copy, and the client dropped it');
    second.stop();
  });

  it('refuses an acknowledgment that names another agent', async () => {
    const sent = await send('claude:sc-3', 'Is the deploy done?');
    const res = await fetch(`${h.server.url}/v1/send/${sent.id}/ack`, { method: 'POST', headers: { authorization: `Bearer ${h.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude:other' }) });
    assert.equal(res.status, 404);
    assert.equal(h.server.inbox.sent(sent.id)?.readAt, null);
  });
});
