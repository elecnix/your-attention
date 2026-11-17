// A card link shows what became of the card it names: answered by the person, taken back by its agent, or neither yet.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { linkOutcome, ownLinkIds } from '../../web/details.js';

function setup() {
  let t = 1000;
  const inbox = new Inbox(new MemoryStorage(), () => ++t);
  const owner: Caller = { token: 'to', role: 'owner' };
  const agent: Caller = { token: 'ta', role: 'agent' };
  return { inbox, owner, agent };
}

describe('the outcome of a linked card', () => {
  it('comes with each card the lookup returns, cleared or not', async () => {
    const { inbox, owner, agent } = setup();
    for (const id of ['answered', 'retracted', 'self', 'open', 'cleared']) inbox.postCard(agent, { id, agent: 's1', title: id });
    const saved = await inbox.answer('answered', {});
    const retracted = inbox.close(agent, 'retracted', 'retracted', 'Not needed.');
    const self = inbox.close(agent, 'self', 'self-answered', 'Found it.');
    await inbox.answer('cleared', {});
    inbox.archive(owner);
    const cards = inbox.linkedCards(owner, ['answered', 'retracted', 'self', 'open', 'cleared']);
    assert.deepEqual(cards['answered']!.outcome, { state: 'answered', at: saved.savedAt });
    assert.deepEqual(cards['retracted']!.outcome, { state: 'closed', kind: 'retracted', at: retracted.closed!.at });
    assert.deepEqual(cards['self']!.outcome, { state: 'closed', kind: 'self-answered', at: self.closed!.at });
    assert.deepEqual(cards['open']!.outcome, { state: 'open' });
    assert.equal(cards['cleared']!.outcome.state, 'answered');
    assert.equal(typeof cards['cleared']!.archivedAt, 'number');
  });

  it('keeps the closed card\'s outcome text and the person\'s draft out of the lookup', () => {
    const { inbox, owner, agent } = setup();
    inbox.postCard(agent, { id: 'c', agent: 's1', title: 'c' });
    inbox.close(agent, 'c', 'resolved', 'Private reason.');
    assert.doesNotMatch(JSON.stringify(inbox.linkedCards(owner, ['c'])), /Private reason/);
  });

  it('leaves out another client\'s cards, as before', () => {
    const { inbox, agent } = setup();
    inbox.postCard(agent, { id: 'mine', agent: 's1', title: 'mine' });
    assert.deepEqual(inbox.linkedCards({ token: 'tb', role: 'agent' }, ['mine']), {});
  });
});

describe('the indicator a card link shows', () => {
  it('says answered when the person answered, whether the agent got it yet or not', () => {
    for (const state of ['answered', 'delivered', 'read']) assert.equal(linkOutcome({ state, at: 5 })!.key, 'answered');
    assert.equal(linkOutcome({ state: 'closed', kind: 'answered-in-terminal', at: 5 })!.key, 'answered');
  });

  it('says taken back when the agent withdrew the card or answered it itself', () => {
    for (const kind of ['retracted', 'self-answered', 'resolved']) {
      const o = linkOutcome({ state: 'closed', kind, at: Date.UTC(2026, 10, 17, 15, 0) })!;
      assert.equal(o.key, 'taken-back');
      assert.equal(o.word, 'taken back');
      assert.match(o.title, /^Taken back/);
      assert.match(o.title, /2026/);
    }
  });

  it('names the other endings by what happened', () => {
    assert.equal(linkOutcome({ state: 'closed', kind: 'dismissed', at: 1 })!.word, 'dismissed');
    assert.equal(linkOutcome({ state: 'closed', kind: 'expired', at: 1 })!.word, 'expired');
    assert.equal(linkOutcome({ state: 'closed', kind: 'returned', at: 1 })!.word, 'sent back');
  });

  it('shows nothing for a card still waiting', () => {
    for (const state of ['open', 'in-triage', 'held', 'orphaned']) assert.equal(linkOutcome({ state }), null);
    assert.equal(linkOutcome(undefined), null);
  });
});

describe('the cards a text links by this inbox\'s address', () => {
  it('finds each #card address of this inbox, and no other', () => {
    const here = 'http://127.0.0.1:4815/';
    assert.deepEqual(ownLinkIds(here, 'See [#12](http://127.0.0.1:4815/#card=a1), http://127.0.0.1:4815/#card=b2 and [x](https://other.cloud/#card=c3).', '#card=d4'), ['a1', 'b2', 'd4']);
  });
});
