// A card whose options carry only a label, as the card_post tool documents them: the pick must reach the agent, on
// the page and in the terminal, and the inbox assigns each such option an id so a stored card always carries one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { Answer, Card } from '../../src/core/types.ts';
import { answerValues, describe as summary, optionValue } from '../../web/answers.js';
import { agent, answered as answer } from './fixture.ts';

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

describe('an id derived beside the ids a card already carries', () => {
  it('stays unique when two labels become one id, and beside an id the agent supplied', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    const card = inbox.postCard(agent, {
      id: 'c1', agent: 's1', title: 'q',
      options: [{ label: 'Go ahead' }, { label: 'Go-ahead!' }, { label: 'Yes, go!' }, { label: 'Yes, go!' }, { id: 'go-ahead', label: 'Supplied' }],
    });
    const ids = card.options!.map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(', '));
    assert.equal(card.options![3]!.id, 'yes-go-2');
    // An id the agent gave stays as it is, and a derived id steps around it.
    assert.equal(card.options![4]!.id, 'go-ahead');
    assert.deepEqual(ids.slice(0, 2), ['go-ahead-2', 'go-ahead-3']);
  });

  it('gives no dash at either end of the label, and numbers past an id a label already took', () => {
    const ids = (labels: string[]): (string | undefined)[] => {
      const inbox = new Inbox(new MemoryStorage(), () => 1);
      return inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q', options: labels.map((label) => ({ label })) }).options!.map((o) => o.id);
    };
    // A run of other characters at either end, or inside, gives one dash, and none at an end.
    assert.deepEqual(ids(['!Go-ahead!']), ['go-ahead']);
    assert.deepEqual(ids(['Go  --  ahead']), ['go-ahead']);
    // A label that spells a numbered id takes it, so the next id adds a dash and the next free number to its own base.
    assert.deepEqual(ids(['Go ahead', 'Go ahead', 'Go ahead 2']), ['go-ahead', 'go-ahead-2', 'go-ahead-2-2']);
    // The first 60 characters of the joined result, and a cut can leave a dash at the end.
    assert.deepEqual(ids(['x'.repeat(80)]), ['x'.repeat(60)]);
    assert.deepEqual(ids([`${'a'.repeat(59)} bcd`]), [`${'a'.repeat(59)}-`]);
    // A label with no letters or digits takes the empty-label rule, by the option's position.
    assert.deepEqual(ids(['!!!', 'Ok']), ['option-1', 'ok']);
    assert.deepEqual(ids(['', '!!!']), ['option-1', 'option-2']);
  });
});

describe('a card that already carries an answer', () => {
  /** A card stored the way an inbox before this change stored it: options with no ids. */
  const storedWithoutIds = (store: MemoryStorage, options: { label: string }[]): void => {
    const card = store.get<Card>('cards', 'c1')!;
    store.put('cards', 'c1', { ...card, options: options.map((o) => ({ ...o })) });
  };

  it('keeps its options without ids through a patch, a re-post and a new option, so the stored answer still resolves', async () => {
    const store = new MemoryStorage();
    const inbox = new Inbox(store, () => 1);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Ship the preview?', text: 'The preview is ready.', options: [{ label: 'Leave it' }, { label: 'Go ahead' }] });
    storedWithoutIds(store, [{ label: 'Leave it' }, { label: 'Go ahead' }]);
    const saved = await inbox.answer('c1', { values: { choice: 'Go ahead' } });
    assert.equal(summary(store.get<Card>('cards', 'c1')!, saved), 'Go ahead');

    const patched = inbox.patchCard(agent, 'c1', [{ old: 'preview is', new: 'preview build is' }]);
    assert.deepEqual(patched.options?.map((o) => o.id), [undefined, undefined]);
    assert.equal(summary(patched, store.get<Answer>('answers', 'c1')!), 'Go ahead');

    // A re-post that adds an option keeps every option without an id too.
    const reposted = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Ship the preview?', text: 'The preview build is ready.', options: [{ label: 'Leave it' }, { label: 'Go ahead' }, { label: 'Stop' }] });
    assert.deepEqual(reposted.options?.map((o) => o.id), [undefined, undefined, undefined]);
    assert.equal(summary(reposted, store.get<Answer>('answers', 'c1')!), 'Go ahead');

    // The page gives the added option, which has no id, by its label in the stored choice.
    assert.deepEqual(answerValues(reposted, { choice: optionValue(reposted.options![2]!) }), { choice: 'Stop' });

    // A re-post that renames a label drops the pick, as any relabel does, and derives no id either.
    const renamed = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Ship the preview?', options: [{ label: 'Leave it' }, { label: 'Go ahead now' }] });
    assert.deepEqual(renamed.options?.map((o) => o.id), [undefined, undefined]);
    assert.equal(summary(renamed, store.get<Answer>('answers', 'c1')!), 'Go ahead');
  });

  it('keeps them without ids through a patch of a dismissed card, so the draft keeps its pick', () => {
    const store = new MemoryStorage();
    const inbox = new Inbox(store, () => 1);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Ship it?', text: 'The build is green.', options: [{ label: 'Leave it' }, { label: 'Go ahead' }] });
    storedWithoutIds(store, [{ label: 'Leave it' }, { label: 'Go ahead' }]);
    const owner = { token: 'owner', role: 'owner' } as const;
    inbox.dismiss(owner as never, 'c1', { values: { choice: 'Leave it' }, comment: 'Not today.' });
    const patched = inbox.patchCard(agent, 'c1', [{ old: 'build is', new: 'build is still' }]);
    assert.deepEqual(patched.options?.map((o) => o.id), [undefined, undefined]);
    assert.equal(patched.closed?.draft?.values['choice'], 'Leave it');
    assert.equal(summary(patched, { card: 'c1', version: 1, values: patched.closed!.draft!.values, comment: '', delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [] }), 'Leave it');
  });

  it('keeps an id answer resolving when a re-post resends the labels without ids', async () => {
    const store = new MemoryStorage();
    const inbox = new Inbox(store, () => 1);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Ship it?', options: [{ label: 'Leave it' }, { label: 'Go ahead' }] });
    const saved = await inbox.answer('c1', { values: { choice: 'go-ahead' } });
    const reposted = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Ship it?', options: [{ label: 'Leave it' }, { label: 'Go ahead' }] });
    assert.deepEqual(reposted.options?.map((o) => o.id), ['leave-it', 'go-ahead']);
    assert.equal(summary(reposted, saved), 'Go ahead');
  });

  it('gives ids to a card with no answer, at post and at patch', () => {
    const store = new MemoryStorage();
    const inbox = new Inbox(store, () => 1);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Ship it?', text: 'The build is green.', options: [{ label: 'Leave it' }, { label: 'Go ahead' }] });
    const patched = inbox.patchCard(agent, 'c1', [{ old: 'build is', new: 'build is still' }]);
    assert.deepEqual(patched.options?.map((o) => o.id), ['leave-it', 'go-ahead']);
  });
});
