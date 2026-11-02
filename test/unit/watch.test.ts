// `your-attention watch` prints one line of JSON per event: the inbox's own event, plus `receivedAt`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { keepEvent, ownerEvent, ownerLine, pickCard, watchLine, type WatchLine } from '../../src/watch.ts';

const card = {
  id: 'c1',
  agent: 'cli:watch',
  kind: 'ask',
  title: 'Deploy now?',
  text: 'CI is green.',
  status: 'waiting on CI',
  priority: 'soon',
  deliver: 'stream',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  replies: [],
} as Card;

const answer: AgentEvent = {
  type: 'answer',
  id: 'receipt-1',
  card,
  answer: {
    card: 'c1',
    version: 1,
    values: { choice: 'o2' },
    comment: 'after lunch',
    delivery: 'default',
    savedAt: 2,
    deliveredAt: null,
    readAt: null,
    forcedAt: null,
    previous: [],
  },
};

/** The card a line carries: only an answer and a returned card bring one. */
const cardOf = (line: WatchLine): Partial<Card> | undefined => (line.type === 'answer' || line.type === 'returned' ? line.card : undefined);

describe('the watcher output', () => {
  it('adds receivedAt to the event the inbox sent, and changes nothing else', () => {
    const hello = { type: 'hello', agent: 'cli:watch', version: 1, guidance: 1 } as AgentEvent;
    assert.deepEqual(watchLine(hello, {}, 1700), { type: 'hello', agent: 'cli:watch', version: 1, guidance: 1, receivedAt: 1700 });
    assert.deepEqual(watchLine(answer, {}, 1700), { ...answer, receivedAt: 1700 });
  });

  it('keeps the whole card by default, and only the fields --select names', () => {
    // The whole card, so a reader needs nothing but the line.
    assert.deepEqual(cardOf(watchLine(answer, {}, 1700)), card);
    // The named fields only, and a name the card does not carry is left out rather than stored as undefined.
    assert.deepEqual(cardOf(watchLine(answer, { fields: ['id', 'title', 'notACardField'] }, 1700)), { id: 'c1', title: 'Deploy now?' });
  });

  it('leaves the card out with --no-card, on an answer and on a returned card', () => {
    const answered = watchLine(answer, { noCard: true }, 1700);
    const returned = watchLine({ type: 'returned', id: 'receipt-2', card, reason: 'no recommendation' }, { noCard: true }, 1700);
    for (const line of [answered, returned]) assert.equal('card' in line, false);
    assert.deepEqual(answered.type === 'answer' ? answered.answer.values : undefined, { choice: 'o2' });
    assert.equal(returned.type === 'returned' ? returned.reason : undefined, 'no recommendation');
  });

  it('carries a guidance event whole, since it has no card to cut', () => {
    const guidance = { type: 'guidance', id: 'receipt-3', guidance: { text: 'Offer three options.', version: 2, at: 5 } } as AgentEvent;
    assert.deepEqual(watchLine(guidance, { noCard: true, fields: ['id'] }, 1700), { ...guidance, receivedAt: 1700 });
  });

  it('cuts a card to named fields, ignoring a name the card does not carry', () => {
    assert.deepEqual(pickCard(card, ['status']), { status: 'waiting on CI' });
    assert.deepEqual(pickCard(card, []), {});
  });
});

describe('the owner watcher output', () => {
  const detail = { card, answer: answer.type === 'answer' ? answer.answer : undefined, state: 'answered' as const, rev: 'r2' };

  it('turns a page change into a line with the whole card, its answer and its state', () => {
    const event = ownerEvent({ type: 'change', card: 'c1' }, detail);
    assert.deepEqual(ownerLine(event, {}, 1700), { type: 'change', id: 'c1', card, answer: detail.answer, state: 'answered', rev: 'r2', receivedAt: 1700 });
  });

  it('cuts the card with --select and leaves it out with --no-card, as for an agent', () => {
    const event = ownerEvent({ type: 'change', card: 'c1' }, detail);
    const picked = ownerLine(event, { fields: ['title'] }, 1700);
    assert.deepEqual(picked.type === 'change' ? picked.card : undefined, { title: 'Deploy now?' });
    const bare = ownerLine(event, { noCard: true }, 1700);
    assert.equal('card' in bare, false);
    assert.equal(bare.type === 'change' ? bare.state : undefined, 'answered', 'the state stays, so a script still sees the answer arrive');
  });

  it('keeps a change whose card is gone, with its id only', () => {
    assert.deepEqual(ownerLine(ownerEvent({ type: 'change', card: 'gone' }, undefined), {}, 1700), { type: 'change', id: 'gone', receivedAt: 1700 });
  });

  it('passes presence and code through as the inbox writes them', () => {
    assert.deepEqual(ownerLine(ownerEvent({ type: 'presence', agent: 'a1', online: true }, undefined), {}, 1700), { type: 'presence', agent: 'a1', online: true, receivedAt: 1700 });
    assert.deepEqual(ownerLine(ownerEvent({ type: 'code' }, undefined), {}, 1700), { type: 'code', receivedAt: 1700 });
  });
});

describe('the watcher filters', () => {
  const change = ownerEvent({ type: 'change', card: 'c1' }, { card, state: 'open' });
  const other = ownerEvent({ type: 'change', card: 'c2' }, { card: { ...card, id: 'c2', agent: 'cli:other' }, state: 'open' });

  it('keeps every event without a filter', () => {
    for (const ev of [change, other, { type: 'code' } as const, { type: 'hello', role: 'owner' } as const]) assert.equal(keepEvent(ev, {}), true);
  });

  it('keeps the cards and presence of the agent --agent names, and the hello lines', () => {
    const filter = { agent: 'cli:watch' };
    assert.equal(keepEvent(change, filter), true);
    assert.equal(keepEvent(other, filter), false);
    assert.equal(keepEvent({ type: 'presence', agent: 'cli:watch', online: false }, filter), true);
    assert.equal(keepEvent({ type: 'presence', agent: 'cli:other', online: false }, filter), false);
    assert.equal(keepEvent({ type: 'hello', role: 'owner' }, filter), true);
    // A change of many cards at once, and a new page source, belong to no one agent.
    assert.equal(keepEvent(ownerEvent({ type: 'change', card: '' }, undefined), filter), false);
    assert.equal(keepEvent({ type: 'code' }, filter), false);
  });

  it('keeps the event types --type names, on either stream', () => {
    assert.equal(keepEvent(change, { types: ['change'] }), true);
    assert.equal(keepEvent({ type: 'hello', role: 'owner' }, { types: ['change'] }), false);
    assert.equal(keepEvent(answer, { types: ['answer', 'returned'] }), true);
    assert.equal(keepEvent({ type: 'hello', agent: 'cli:watch', version: 1, guidance: 1 }, { types: ['answer'] }), false);
  });
});
