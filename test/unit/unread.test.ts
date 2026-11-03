// `GET /v1/unread`: the answers a client stored but never acknowledged, which is what a watcher asks about at exit.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Caller } from '../../src/core/inbox.ts';
import { agent, owner, setup } from './fixture.ts';



describe('the answers a client has not consumed', () => {
  it('counts what was answered and never acknowledged, for that agent and that token', async () => {
    const inbox = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'One' });
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Two' });
    inbox.postCard(agent, { id: 'other', agent: 's2', title: 'Another agent' });
    await inbox.answer('c1', { values: {} });
    await inbox.answer('c2', { values: {} });
    await inbox.answer('other', { values: {} });
    assert.deepEqual(inbox.unread(agent, 's1'), { unread: 2, cards: ['c1', 'c2'] });
    assert.deepEqual(inbox.unread(agent, 's2'), { unread: 1, cards: ['other'] });
    assert.equal(inbox.unread(agent).unread, 3, 'no agent means every card this token owns');
    // An ack takes one out, and a card with no answer was never in the count.
    inbox.ack(agent, 'c1');
    assert.deepEqual(inbox.unread(agent, 's1'), { unread: 1, cards: ['c2'] });
  });

  it('leaves out a closed card, and another client\'s cards', async () => {
    const inbox = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'One' });
    await inbox.answer('c1', { values: {} });
    inbox.close(agent, 'c1', 'resolved', 'done');
    assert.equal(inbox.unread(agent, 's1').unread, 0, 'a closed card is not something to acknowledge');
    const stranger: Caller = { token: 'ta2', role: 'agent' };
    inbox.postCard(stranger, { id: 'c3', agent: 's3', title: 'Three' });
    await inbox.answer('c3', { values: {} });
    assert.equal(inbox.unread(agent).unread, 0, 'another token\'s cards are not this client\'s to acknowledge');
    assert.equal(inbox.unread({ token: 'to', role: 'owner' }).unread, 1, 'the owner sees every card');
  });
});
