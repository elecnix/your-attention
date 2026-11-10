// Dismissing a card: close without telling the agent.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, cardState, publicCard, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { buildQueue, type InboxState } from '../../web/queue.js';

const agent: Caller = { token: 'ta', role: 'agent' };
const owner: Caller = { token: 'to', role: 'owner' };

function setup() {
  let t = 1000;
  const inbox = new Inbox(new MemoryStorage(), () => ++t);
  inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?', text: 'Pick a size.', options: [{ id: 'o1', label: 'Small' }, { id: 'o2', label: 'Large' }] });
  return inbox;
}

/** The status the inbox refuses a call with, or 0 when it takes it. */
function refusal(call: () => unknown): number {
  try {
    call();
    return 0;
  } catch (e) {
    return e instanceof InboxError ? e.status : 0;
  }
}

describe('dismiss', () => {
  it('keeps the draft when the agent closes the card later', () => {
    const inbox = setup();
    inbox.dismiss(owner, 'c1', { values: { choice: 'o2' }, comment: 'Not needed any more.' });
    const closed = inbox.close(agent, 'c1', 'retracted', 'Withdrawn.');
    assert.equal(closed.closed?.kind, 'retracted');
    assert.deepEqual(closed.closed?.draft?.values, { choice: 'o2' }, 'the person\'s draft survives');
    assert.equal(closed.closed?.draft?.comment, 'Not needed any more.');
  });

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
    const draft = setup().dismiss(owner, 'c1', {}).closed?.draft;
    assert.deepEqual(draft?.values, {});
    assert.equal(draft?.comment, '');
    assert.equal(typeof draft?.at, 'number');
  });

  it('refuses a caller who is not the owner, and a card that is already closed', () => {
    const inbox = setup();
    assert.equal(refusal(() => inbox.dismiss(agent, 'c1', {})), 403);
    inbox.dismiss(owner, 'c1', {});
    assert.equal(refusal(() => inbox.dismiss(owner, 'c1', {})), 409);
  });

  it('keeps the dismissed kind for the owner: an agent\'s close refuses it', () => {
    assert.equal(refusal(() => setup().close(agent, 'c1', 'dismissed' as never, 'x')), 400);
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

  it('keeps a later agent patch off the queue: saved, still closed, still dismissed', () => {
    const inbox = setup();
    inbox.dismiss(owner, 'c1', {});
    const card = inbox.getCard('c1');
    assert.equal(cardState(card, undefined), 'closed');
    assert.equal(card.closed?.kind, 'dismissed');
    inbox.patchCard(agent, 'c1', [{ old: 'Pick a size.', new: 'Pick a colour.' }]);
    const patched = inbox.getCard('c1');
    assert.equal(patched.text, 'Pick a colour.');
    assert.equal(patched.closed?.kind, 'dismissed', 'the patch did not reopen the card');
  });

  it('puts a dismissed card in Sent', () => {
    const dismissed = {
      id: 'c1', agent: 's1', kind: 'ask', title: 'Which one?', priority: 'soon', deliver: 'stream', version: 1,
      createdAt: 0, updatedAt: 1, closed: { kind: 'dismissed' as const, outcome: 'Dismissed.', at: 1 }, rev: 'r1',
    };
    const state = { cards: [dismissed], answers: {}, presence: {}, states: { c1: 'closed' }, priorities: {}, levels: [], settings: { allowHtml: false }, guidance: { text: '', version: 1, at: 0 } } as InboxState;
    const queue = buildQueue(state, 'none');
    assert.equal(queue.st(queue.byId['c1']!), 'closed');
    assert.ok(queue.sent.some((c) => c.id === 'c1'), 'the dismissed card is in Sent');
  });
});
