// Dismissing a card: close without telling the agent, and replies that wait for a real action.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InboxError, cardState, publicCard } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { buildQueue, type InboxState } from '../../web/queue.js';

const agent: Caller = { token: 'ta', role: 'agent' };
const owner: Caller = { token: 'to', role: 'owner' };

function setup() {
  let t = 1000;
  const inbox = new Inbox(new MemoryStorage(), () => ++t);
  inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?', text: 'Pick a size.', options: [{ id: 'o1', label: 'Small' }, { id: 'o2', label: 'Large' }] });
  return inbox;
}

describe('dismiss', () => {
  it('closes the card as dismissed, records the draft with its time, and the agent hears nothing', () => {
    const inbox = setup();
    const heard: AgentEvent[] = [];
    inbox.connect(agent, 's1', (ev) => heard.push(ev));
    heard.length = 0;
    const card = inbox.dismiss(owner, 'c1', { values: { choice: 'o2' }, comment: 'Not needed any more.' });
    assert.equal(card.closed?.kind, 'dismissed');
    assert.deepEqual(card.closed?.draft?.values, { choice: 'o2' });
    assert.equal(card.closed?.draft?.comment, 'Not needed any more.');
    assert.equal(typeof card.closed?.draft?.at, 'number');
    assert.equal(cardState(inbox.getCard('c1'), undefined), 'closed');
    assert.equal(heard.length, 0, 'the agent stream received nothing');
    assert.equal(inbox.state().answers['c1'], undefined, 'a dismiss stores no answer');
  });

  it('leaves the delivery and read state of an earlier answer alone, and sends no event', async () => {
    const inbox = setup();
    const heard: AgentEvent[] = [];
    inbox.connect(agent, 's1', (ev) => heard.push(ev));
    await inbox.answer('c1', { values: { choice: 'o2' }, comment: 'Ship the large one.' });
    inbox.ack(agent, 'c1');
    const before = inbox.state().answers['c1'];
    assert.ok(before?.deliveredAt && before.readAt, 'the answer went out and the model read it');
    heard.length = 0;
    inbox.dismiss(owner, 'c1', {});
    const after = inbox.state().answers['c1'];
    assert.equal(after?.deliveredAt, before.deliveredAt);
    assert.equal(after?.readAt, before.readAt);
    assert.equal(heard.length, 0, 'a dismiss sends no event');
  });

  it('records an empty draft, with the time, when nothing was typed', () => {
    const inbox = setup();
    const card = inbox.dismiss(owner, 'c1', {});
    assert.deepEqual(card.closed?.draft?.values, {});
    assert.equal(card.closed?.draft?.comment, '');
    assert.equal(typeof card.closed?.draft?.at, 'number');
  });

  it('is owner-only', () => {
    const inbox = setup();
    assert.throws(() => inbox.dismiss(agent, 'c1', {}), (e: unknown) => e instanceof InboxError && e.status === 403);
  });

  it('refuses a card that is already closed', () => {
    const inbox = setup();
    inbox.dismiss(owner, 'c1', {});
    assert.throws(() => inbox.dismiss(owner, 'c1', {}), (e: unknown) => e instanceof InboxError && e.status === 409);
  });

  it('is not a close kind an agent may use', () => {
    const inbox = setup();
    assert.throws(() => inbox.close(agent, 'c1', 'dismissed' as never, 'x'), (e: unknown) => e instanceof InboxError && e.status === 400);
  });

  it('keeps the draft from agents: publicCard, the state, and search', () => {
    const inbox = setup();
    inbox.dismiss(owner, 'c1', { values: { choice: 'o2' }, comment: 'Quiet thought.' });
    assert.equal(publicCard(inbox.getCard('c1')).closed?.draft, undefined, 'publicCard has no draft');
    assert.equal(inbox.cardDetail('c1').card.closed?.draft, undefined, 'the whole card for an agent has no draft');
    assert.ok(inbox.cardDetail('c1', true).card.closed?.draft, 'the owner reads the draft');
    const summary = inbox.summaryState().cards.find((c) => c.id === 'c1');
    assert.ok(summary && !('draft' in summary.closed!), 'the state summary has no draft');
    assert.equal(inbox.search('quiet thought').length, 0, 'the draft comment is not indexed for search');
  });

  it('marks the card\'s agent replies as seen', () => {
    const inbox = setup();
    inbox.reply(agent, 'c1', 'Here is the diff you asked for.');
    assert.equal(inbox.getCard('c1').replies[0]?.seenAt, null);
    inbox.dismiss(owner, 'c1', {});
    assert.ok(inbox.getCard('c1').replies[0]?.seenAt, 'the dismiss counted as seeing the reply');
  });

  it('keeps a later agent reply or patch off the queue: saved, still closed, still dismissed', () => {
    const inbox = setup();
    inbox.dismiss(owner, 'c1', {});
    inbox.reply(agent, 'c1', 'Noted.');
    const card = inbox.getCard('c1');
    assert.equal(card.replies.length, 1, 'the reply is saved');
    assert.equal(cardState(card, undefined), 'closed');
    assert.equal(card.closed?.kind, 'dismissed');
    inbox.patchCard(agent, 'c1', [{ old: 'Pick a size.', new: 'Pick a colour.' }]);
    const patched = inbox.getCard('c1');
    assert.equal(patched.text, 'Pick a colour.');
    assert.equal(patched.closed?.kind, 'dismissed', 'the patch did not reopen the card');
  });

  it('puts a dismissed card with a later reply in Sent, never under Agent replied', () => {
    const summary = {
      id: 'c1', agent: 's1', kind: 'ask', title: 'Which one?', priority: 'soon', deliver: 'stream', version: 1,
      createdAt: 0, updatedAt: 1, closed: { kind: 'dismissed' as const, outcome: 'Dismissed.', at: 1 }, replyAt: 2, unseenReplies: true, rev: 'r1',
    };
    const retracted = { ...summary, id: 'c2', title: 'Retracted one', closed: { kind: 'retracted' as const, outcome: 'Gone.', at: 1 } };
    const state = { cards: [summary, retracted], answers: {}, presence: {}, states: { c1: 'closed', c2: 'closed' }, priorities: {}, levels: [], settings: { allowHtml: false }, guidance: { text: '', version: 1, at: 0 } } as InboxState;
    const queue = buildQueue(state, 'none');
    assert.equal(queue.st(queue.byId['c1']!), 'closed', 'a dismissed card with an unseen reply stays closed');
    assert.equal(queue.st(queue.byId['c2']!), 'reply', 'any other closed card with an unseen reply still comes back');
    assert.deepEqual(queue.replied.map((c) => c.id), ['c2']);
    assert.ok(queue.sent.some((c) => c.id === 'c1'), 'the dismissed card is in Sent');
  });
});

describe('replies seen', () => {
  it('keeps an unread reply in the summary until the person acts on the card', async () => {
    const inbox = setup();
    inbox.reply(agent, 'c1', 'Still waiting on this.');
    assert.equal(inbox.summaryState().cards[0]?.unseenReplies, true);
    await inbox.answer('c1', { values: { choice: 'o1' } });
    assert.equal(inbox.summaryState().cards[0]?.unseenReplies, undefined, 'the answer counted as seeing the reply');
  });

  it('counts a reply as seen when the person answers the card', async () => {
    const inbox = setup();
    inbox.reply(agent, 'c1', 'Still waiting on this.');
    assert.equal(inbox.getCard('c1').replies[0]?.seenAt, null);
    await inbox.answer('c1', { values: { choice: 'o1' } });
    assert.ok(inbox.getCard('c1').replies[0]?.seenAt, 'the answer counted as seeing the reply');
  });

  it('leaves an unread reply unseen while nobody acts on the card', () => {
    const inbox = setup();
    inbox.reply(agent, 'c1', 'Still waiting on this.');
    inbox.getCard('c1');
    assert.equal(inbox.getCard('c1').replies[0]?.seenAt, null, 'reading changes nothing');
  });
});
