// A card whose options carry only a label, as the card_post tool documents them: the pick must reach the agent, on
// the page and in the terminal, and the inbox assigns each such option an id so a stored card always carries one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { Answer, Card } from '../../src/core/types.ts';
import { answerValues, describe as summary, optionValue } from '../../web/answers.js';
import { agent } from './fixture.ts';

const answer = (values: Record<string, unknown>): Answer => ({ card: 'c1', version: 1, values, comment: '', delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [] });

const labelOnly = { id: 'c1', kind: 'ask', title: 'Proceed?', options: [{ label: 'Leave it' }, { label: 'Go ahead', recommended: true }] } as unknown as Card;

describe('an option without an id', () => {
  it('values the pick by the option, so JSON keeps it', () => {
    assert.notEqual(optionValue({ label: 'Leave it' } as never), 'undefined:Leave it');
    const values = answerValues(labelOnly, { choice: optionValue(labelOnly.options![0] as never) });
    assert.equal(JSON.parse(JSON.stringify(values)).choice, 'Leave it');
  });

  it('describes the answer with the picked label', () => {
    const values = answerValues(labelOnly, { choice: optionValue(labelOnly.options![0] as never) });
    assert.equal(summary(labelOnly, answer(values)), 'Leave it');
  });

  it('keeps an id option answering by its id, and its summary unchanged', () => {
    const card = { id: 'c2', kind: 'ask', title: 'Which?', options: [{ id: 'o1', label: 'SQLite' }, { id: 'o2', label: 'Postgres' }] } as unknown as Card;
    assert.equal(optionValue({ id: 'o2', label: 'Postgres' }), 'o2:Postgres');
    assert.deepEqual(answerValues(card, { choice: 'o2:Postgres' }), { choice: 'o2' });
    assert.equal(summary(card, answer({ choice: 'o2' })), 'Postgres');
  });
});

describe('the inbox assigns an id to an option posted without one', () => {
  it('stores each label-only option with an id, on a post and on a revision', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    const card = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Proceed?', options: [{ label: 'Leave it' }, { label: 'Go ahead', recommended: true }] });
    assert.deepEqual(card.options?.map((o) => o.id), ['leave-it', 'go-ahead']);
    assert.equal(card.options?.[1]?.recommended, true);
    // A revision that reposts the same labels keeps the ids they already carry.
    const next = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Proceed?', options: card.options });
    assert.deepEqual(next.options?.map((o) => o.id), ['leave-it', 'go-ahead']);
  });

  it('derives the id from the label, unique within the card, and leaves an id the agent gave alone', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    const card = inbox.postCard(agent, {
      id: 'c1', agent: 's1', title: 'q',
      options: [{ id: 'keep-me', label: 'First' }, { label: 'Yes, go!' }, { label: 'Yes, go!' }, { label: '' } as never, { label: 'leave-it' }, { label: 'leave it' }],
    });
    assert.deepEqual(card.options?.map((o) => o.id), ['keep-me', 'yes-go', 'yes-go-2', 'option-4', 'leave-it', 'leave-it-2']);
  });
});
