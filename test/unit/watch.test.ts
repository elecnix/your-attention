// `your-attention watch` prints one line of JSON per event: the inbox's own event, plus `receivedAt`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { pickCard, watchLine, type WatchLine } from '../../src/watch.ts';

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
