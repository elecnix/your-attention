// A card that asks several questions draws each one as its own section, and the agent receives each choice and comment
// under its own question.
import { expect, test } from '@playwright/test';
import { describeAnswer } from '../../src/client.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const questions = [
  { question: 'Which database?', text: 'The service stores **one table** of jobs.', options: [{ label: 'SQLite', description: 'One file next to the binary.', recommended: true }, { label: 'Postgres' }] },
  { question: 'Which regions?', text: 'Each region adds a deploy step.', multiSelect: true, options: [{ label: 'us-east' }, { label: 'eu-west' }] },
  { question: 'What must the release note say?', text: 'The note goes out with the tag.' },
];

test('each question has its own section and comment field, and the agent reads each answer under its question', async ({ page }) => {
  const heard = inbox.listen('s-questions');
  await inbox.agent.post({ id: 'three', agent: 's-questions', title: 'Three choices before the release', text: 'This agent prepares the release.', questions, priority: 'now' });
  await inbox.open(page);
  const card = page.locator('.focus-card');
  await expect(card.locator('.card-title')).toHaveText('Three choices before the release');
  // The sections come in the order the agent gave, each heading above its own text.
  const headings = card.locator('.card-body h3');
  await expect(headings).toHaveText(questions.map((q) => q.question));
  await expect(card.getByText('Recommended', { exact: true })).toHaveCount(1);
  // The question headings are bright, as the card title is, and the question text reads in the body color.
  const ink = await card.locator('.card-title').evaluate((el) => getComputedStyle(el).color);
  await expect(headings.first()).toHaveCSS('color', ink);

  // Two of the three questions get a pick and a comment each.
  await card.getByText('Postgres', { exact: true }).click();
  await card.getByPlaceholder('Why, or anything to add').nth(0).fill('We run it already.');
  await card.getByText('eu-west', { exact: true }).click();
  await card.getByPlaceholder('Why, or anything to add').nth(1).fill('Most users are there.');
  await card.getByRole('button', { name: 'Send answer' }).click();

  await expect.poll(() => heard.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const ev = heard.events.find((e) => e.type === 'answer');
  if (ev?.type !== 'answer') throw new Error('no answer');
  expect(ev.answer.values).toEqual({ q0: 'Postgres', q0_comment: 'We run it already.', q1: ['eu-west'], q1_comment: 'Most users are there.' });
  expect(describeAnswer(ev.card, ev.answer)).toBe([
    'Which database? Postgres',
    '  Comment: We run it already.',
    'Which regions? eu-west',
    '  Comment: Most users are there.',
    'What must the release note say? (no answer)',
  ].join('\n'));
});
