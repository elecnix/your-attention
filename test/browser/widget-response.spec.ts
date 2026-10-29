// A check box whose label shows editable text, inside a widget whose response tells the agent what to do with the answer.
import { expect, test } from '@playwright/test';
import { describeAnswer } from '../../src/client.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  await inbox.agent.saveWidget('team-review', [
    'root = FormControl("Ask for a review", ask)',
    'ask = CheckWithText("Ask the team for a review", check, [msg])',
    'check = CheckBoxGroup("ask_review", [yes])',
    'yes = CheckBoxItem("", "", "yes")',
    'msg = TextArea("message", "", 6, {}, {{message}})',
  ].join('\n'), undefined, {
    when: 'A pull request needs a review from the team.',
    response: '{{#ask_review}}Post this to the team channel:\n{{message}}{{/ask_review}}{{^ask_review}}Do not post.{{/ask_review}}',
  });
});
test.afterAll(async () => { await inbox.close(); });

const post = (id: string, agent: string) => inbox.agent.post({ id, agent, title: `Review ${id}?`, priority: 'now',
  body: `root = Card([r])\nr = widget team-review ${JSON.stringify({ message: '> Fixes the build.\nhttps://example.com/pull/1' })}` });

test('the label shows the text when clicked, previews it on hover, and the agent gets the response with the edited text', async ({ page }) => {
  const heard = inbox.listen('s-review-edit');
  await post('edit', 's-review-edit');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Review edit?' }).click();
  const label = page.locator('.focus-card .check-with-text .reveal');
  await expect(label).toHaveText('Ask the team for a review');
  const text = page.locator('.focus-card .check-with-text textarea');
  await expect(text).toBeHidden();
  // Hovering the label previews the text the agent prefilled.
  await label.hover();
  await expect(label).toHaveAttribute('title', '> Fixes the build.\nhttps://example.com/pull/1');
  await label.click();
  await expect(text).toBeVisible();
  await expect(text).toHaveValue('> Fixes the build.\nhttps://example.com/pull/1');
  await text.fill('> Fixes the build, and the flaky test.\nhttps://example.com/pull/1');
  await label.hover();
  await expect(label).toHaveAttribute('title', /and the flaky test/);
  // Clicking the label does not tick the box: the check box beside it does.
  await page.locator('.focus-card .check-with-text').getByRole('checkbox').click();
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await expect.poll(() => heard.events.find((e) => e.type === 'answer')).toBeTruthy();
  const ev = heard.events.find((e) => e.type === 'answer');
  if (ev?.type !== 'answer') throw new Error('no answer');
  expect(describeAnswer(ev.card, ev.answer)).toContain('Post this to the team channel:\n> Fixes the build, and the flaky test.\nhttps://example.com/pull/1');
});

test('a box ticked without opening the text sends the prefilled text, and a box left empty says not to post', async ({ page }) => {
  const ticked = inbox.listen('s-review-tick');
  const left = inbox.listen('s-review-skip');
  await post('tick', 's-review-tick');
  await post('skip', 's-review-skip');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Review tick?' }).click();
  await page.locator('.focus-card .check-with-text').getByRole('checkbox').click();
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await page.locator('.q', { hasText: 'Review skip?' }).click();
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  const said = async (l: typeof ticked) => {
    await expect.poll(() => l.events.find((e) => e.type === 'answer')).toBeTruthy();
    const ev = l.events.find((e) => e.type === 'answer');
    return ev?.type === 'answer' ? describeAnswer(ev.card, ev.answer) : '';
  };
  expect(await said(ticked)).toContain('Post this to the team channel:\n> Fixes the build.\nhttps://example.com/pull/1');
  expect(await said(left)).toContain('Do not post.');
});
