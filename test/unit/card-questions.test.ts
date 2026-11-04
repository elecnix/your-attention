// A card that asks several questions, each with its own text, options and comment field: what card_post stores, how
// the inbox checks it, and the answer the agent reads.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAnswer } from '../../src/client.ts';
import { Inbox, InboxError } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { Answer, Card, NewCard } from '../../src/core/types.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { answerValues, cardSource, describe as summary, questionRecommendations } from '../../web/answers.js';
import { agent } from './fixture.ts';

const THREE = [
  { question: 'Which database?', header: 'Database', text: 'The service stores **one table** of jobs.', options: [{ label: 'SQLite', description: 'One file next to the binary.', recommended: true }, { label: 'Postgres' }] },
  { question: 'Which regions?', text: 'Each region adds a deploy step.', multiSelect: true, options: [{ label: 'us-east' }, { label: 'eu-west', recommended: true }, { label: 'ap-south', recommended: true }] },
  { question: 'Anything the release note must say?', text: 'The note goes out with the tag.' },
];

async function post(args: Record<string, unknown>): Promise<NewCard> {
  let posted: NewCard | undefined;
  const inbox = { post: async (c: NewCard) => { posted = c; return { id: 'c1' }; } } as never;
  await runTool({ inbox, secrets: {} as never, agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', args);
  assert.ok(posted);
  return posted;
}

const answer = (values: Record<string, unknown>, comment = ''): Answer => ({ card: 'c1', version: 1, values, comment, delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [] });

describe('a card with questions', () => {
  it('posts each question with its text, its options and the options it recommends, and the inbox stores them', async () => {
    const posted = await post({ title: 'Three choices before the release', text: 'This agent prepares the release.', questions: THREE });
    assert.deepEqual(posted.questions, THREE);
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    const card = inbox.postCard(agent, { ...posted, id: 'c1' });
    assert.deepEqual(card.questions, THREE);
    assert.equal(card.dialog, undefined);
  });

  it('drops a recommended flag that is not true, and takes a plain label as an option', async () => {
    const posted = await post({ title: 'q', questions: [{ question: 'Which?', options: ['A', { label: 'B', recommended: 'yes' }] }] });
    assert.deepEqual(posted.questions, [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]);
  });

  it('refuses a question without its text, two options with one label, and two recommended options on a single-choice question', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    const bad = (questions: unknown, re: RegExp) => assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'q', questions } as NewCard),
      (e: unknown) => e instanceof InboxError && e.status === 400 && re.test(e.message));
    bad([{ text: 'no question' }], /question 1: question must be a non-empty string/);
    bad([{ question: 'A?', options: [{ label: 'x' }, { label: 'x' }] }], /question 1: two options have the label x/);
    bad([{ question: 'A?' }, { question: 'B?', options: [{ label: 'x', recommended: true }, { label: 'y', recommended: true }] }], /question 2: a question without multiSelect takes at most one recommended option/);
    bad('A?', /questions must be a list/);
  });

  it('draws the card text first, then each question as its own section with its text, its options and its comment field', () => {
    const card = { id: 'c1', kind: 'ask', title: 'Three choices', questions: THREE } as Card;
    const src = cardSource(card);
    const order = ['"### Which database?\\n\\nThe service stores **one table** of jobs."', 'OptionCards("q0"', 'TextArea("q0_comment"',
      '"### Which regions?', 'OptionCards("q1", "multiple"', 'TextArea("q1_comment"',
      '"### Anything the release note must say?', 'TextArea("q2"', 'TextArea("comment"'];
    const at = order.map((s) => src.indexOf(s));
    assert.ok(at.every((n) => n >= 0), `missing in:\n${src}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    // A free-text question has its answer field and no second comment field.
    assert.ok(!src.includes('q2_comment'));
  });

  it('gives the agent each choice and comment under its own question', () => {
    const card = { id: 'c1', kind: 'ask', title: 'Three choices', questions: THREE } as Card;
    const values = answerValues(card, { q0: 'SQLite', q0_comment: 'One file is enough.', q1: ['eu-west'], q1_comment: '', q2: 'Say that the API is unchanged.' });
    assert.deepEqual(values, { q0: 'SQLite', q0_comment: 'One file is enough.', q1: ['eu-west'], q2: 'Say that the API is unchanged.' });
    const text = describeAnswer(card, answer(values, 'Go ahead.'));
    assert.equal(text, [
      'Which database? SQLite',
      '  Comment: One file is enough.',
      'Which regions? eu-west',
      'Anything the release note must say? Say that the API is unchanged.',
      'Comment: Go ahead.',
    ].join('\n'));
    assert.equal(summary(card, answer(values, 'Go ahead.')), text);
  });

  it('drops a comment for a question a revision removed', () => {
    const card = { id: 'c1', kind: 'ask', title: 'One left', questions: [THREE[0]] } as Card;
    assert.deepEqual(answerValues(card, { q0: 'SQLite', q1: ['eu-west'], q1_comment: 'gone' }), { q0: 'SQLite' });
  });

  it('names the options each question recommends, for the page and the terminal to tag', () => {
    assert.deepEqual(questionRecommendations({ questions: THREE }), { q0: ['SQLite'], q1: ['eu-west', 'ap-south'] });
  });

  it('stores the answer with each choice and comment under its question index', async () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q', questions: THREE });
    const saved = await inbox.answer('c1', { values: { q0: 'Postgres', q0_comment: 'We run it already.' }, comment: '' });
    assert.deepEqual(saved.values, { q0: 'Postgres', q0_comment: 'We run it already.' });
  });

  it('marks a stored AskUserQuestion card from before the dialog field, once, and leaves other cards alone', () => {
    const store = new MemoryStorage();
    const base = { agent: 'claude:s1', kind: 'ask', priority: 'now', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] };
    const asked = [{ question: 'Which port?', options: [{ label: '4815' }, { label: '8080' }] }];
    store.put('cards', 'ask-0a1b2c3d', { ...base, id: 'ask-0a1b2c3d', title: 'Which port?', questions: asked, origin: { harness: 'claude-code', session: 's1' } });
    store.put('cards', 'raw', { ...base, id: 'raw', title: 'Which port?', questions: asked, origin: { harness: 'pi' } });
    const inbox = new Inbox(store, () => 1);
    assert.equal(inbox.getCard('ask-0a1b2c3d').dialog, true);
    assert.equal(inbox.getCard('raw').dialog, undefined);
    // A card posted after the inbox marked the old ones keeps the field its poster gave, whatever its id.
    inbox.postCard(agent, { id: 'ask-99999999', agent: 'claude:s2', title: 'Later', questions: asked, origin: { harness: 'claude-code' } });
    assert.equal(new Inbox(store, () => 1).getCard('ask-99999999').dialog, undefined);
  });
});
