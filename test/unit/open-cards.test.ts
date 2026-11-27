// A card_post reply and an answer event end with the agent's other open cards, so the agent sees what still waits on the
// person without a search (SPEC.md, "Cards" and "Delivery").
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent, NewCard } from '../../src/core/types.ts';
import { describeOpenCards } from '../../src/client.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { httpInbox, NOW } from './fixture.ts';

const MIN = 60_000;

/** An inbox behind the HTTP handler with a clock the test moves, and card_post for agent `s1` of token A. */
async function setup() {
  let now = NOW;
  const inbox = new Inbox(new MemoryStorage(), () => now);
  const h = await httpInbox(inbox);
  const client = {
    post: async (card: NewCard) => (await h.call('POST', '/v1/cards', { token: h.agentA, body: card })).json(),
    secretLookup: async () => ({ candidates: [], sources: [] }),
  };
  const ctx = (agent = 's1') => ({ inbox: client as never, secrets: new SecretRequests(), agent, origin: async () => undefined, arrival: 'as a channel event' });
  const post = (id: string, title = `Card ${id}`, agent = 's1') => runTool(ctx(agent), 'card_post', { id, title, text: 'Context.' });
  const answer = (id: string) => h.call('POST', `/v1/cards/${id}/answer`, { token: h.owner, body: { values: { choice: 'yes' } } });
  return { ...h, post, answer, advance: (ms: number) => { now += ms; } };
}

describe('the open cards in a card_post reply', () => {
  it('says there are none for the first card, and lists the first card under the second', async () => {
    const t = await setup();
    const first = await t.post('c1', 'Use SQLite?');
    assert.match(first, /Posted card c1\..*\n\nYou have no other open cards\.$/s);
    t.advance(15 * MIN);
    const second = await t.post('c2', 'Which name?');
    assert.match(second, /\n\nYou have 1 other open card, oldest first:\n- c1 "Use SQLite\?": open, priority soon, posted 15 min ago$/);
    assert.doesNotMatch(second, /- c2 /);
  });

  it('lists a card the person answered and the agent has not read, and marks it', async () => {
    const t = await setup();
    await t.post('c1', 'Use SQLite?');
    assert.equal((await t.answer('c1')).status, 200);
    const reply = await t.post('c2');
    assert.match(reply, /- c1 "Use SQLite\?": ANSWERED, unread, priority soon/);
  });

  it('lists ten cards, oldest first, and counts the rest', async () => {
    const t = await setup();
    for (let i = 1; i <= 11; i++) { await t.post(`c${i}`); t.advance(MIN); }
    const reply = await t.post('c12');
    const lines = reply.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, 10);
    assert.deepEqual(lines.map((l) => l.split(' ')[1]), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
    assert.match(reply, /You have 11 other open cards, oldest first:/);
    assert.match(reply, /\n… and 1 more$/);
  });

  it('leaves out the cards of another agent, under the same token and under another', async () => {
    const t = await setup();
    await t.post('mine', 'Mine');
    await t.post('sibling', 'Another session', 's2');
    await t.call('POST', '/v1/cards', { token: t.agentB, body: { id: 'foreign', agent: 's1', title: 'Another token', text: 'x' } });
    const reply = await t.post('c2');
    assert.match(reply, /You have 1 other open card/);
    assert.match(reply, /- mine "Mine"/);
    assert.doesNotMatch(reply, /sibling|foreign/);
  });

  it('leaves out a card the agent closed and a card whose answer it read', async () => {
    const t = await setup();
    await t.post('retracted');
    await t.call('POST', '/v1/cards/retracted/close', { token: t.agentA, body: { kind: 'retracted', outcome: 'no longer needed' } });
    await t.post('read');
    await t.answer('read');
    await t.call('POST', '/v1/cards/read/ack', { token: t.agentA });
    const reply = await t.post('c3');
    assert.match(reply, /You have no other open cards\.$/);
  });
});

describe('the open cards in an answer event', () => {
  it('lists what still waits, without the card it answers', async () => {
    const t = await setup();
    const events: AgentEvent[] = [];
    t.inbox.connect({ token: (await t.inbox.authenticate(t.agentA))!.id, role: 'agent' }, 's1', (ev) => events.push(ev), 'i1');
    await t.post('c1', 'Use SQLite?');
    t.advance(5 * MIN);
    await t.post('c2', 'Which name?');
    await t.answer('c1');
    const ev = events.find((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer');
    assert.ok(ev?.openCards);
    assert.deepEqual(ev.openCards.cards.map((c) => c.id), ['c2']);
    assert.equal(describeOpenCards(ev.openCards), '\n\nYou have 1 other open card, oldest first:\n- c2 "Which name?": open, priority soon, posted just now');
  });

  it('says nothing for an inbox that sends no list', () => {
    assert.equal(describeOpenCards(undefined), '');
  });
});
