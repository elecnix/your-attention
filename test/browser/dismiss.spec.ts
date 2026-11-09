// Issue 38: dismiss a card without telling its agent, and reply to a card whose agent answered.
import { expect, test } from '@playwright/test';
import type { Card, Answer } from '../../src/core/types.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const cardDetail = async (id: string): Promise<{ card: Card; answer?: Answer }> => {
  const res = await fetch(`${inbox.server.url}/v1/cards/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } });
  return (await res.json()) as { card: Card; answer?: Answer };
};

test('a comment and a pick are recorded, then Dismiss moves the card to Sent and tells the agent nothing', async ({ page }) => {
  const heard = inbox.listen('s-dismiss');
  await inbox.agent.post({ id: 'plan', agent: 's-dismiss', title: 'Pick a plan', text: 'Pick the size that fits.', priority: 'now', options: [{ id: 'o1', label: 'Small' }, { id: 'o2', label: 'Large' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Pick a plan' }).click();
  await page.getByText('Large', { exact: true }).click();
  await page.locator('.focus-card textarea').last().fill('Changed my mind about this.');
  const dismiss = page.locator('.focus-card .openui-buttons .ib-titled');
  await expect(dismiss).toHaveAttribute('title', 'Dismiss without telling the agent');
  await dismiss.getByRole('button', { name: 'Dismiss without telling the agent' }).click();
  // The card leaves the queue for Sent, and reads Dismissed with the draft the person had on screen.
  await expect(page.locator('nav.queue .q.dim', { hasText: 'Pick a plan' })).toBeVisible();
  await page.locator('nav.queue .q.dim', { hasText: 'Pick a plan' }).click();
  await expect(page.locator('.closed-line .tag')).toHaveText('Dismissed');
  await expect(page.locator('.dismiss-draft')).toContainText('Changed my mind about this.');
  await expect(page.locator('.dismiss-draft')).toContainText('Large');
  const stored = await cardDetail('plan');
  expect(stored.card.closed?.kind).toBe('dismissed');
  expect(stored.card.closed?.draft?.comment).toBe('Changed my mind about this.');
  expect(stored.answer).toBeUndefined();
  // The agent's stream heard no answer, no event and no new turn.
  await page.waitForTimeout(1500);
  // A beat is the stream saying it is alive, so it is not the leak this test looks for.
  expect(heard.events.filter((e) => e.type !== 'hello' && (e.type as string) !== 'beat')).toEqual([]);
});

test('dismissing a replied card keeps a later agent reply out of the queue, though it is saved', async ({ page }) => {
  await inbox.agent.post({ id: 'ship', agent: 's-ship', title: 'Ship it?', priority: 'now', options: [{ id: 'o1', label: 'Ship' }, { id: 'o2', label: 'Hold' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Ship it?' }).click();
  await page.getByText('Ship', { exact: true }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(async () => (await cardDetail('ship')).answer?.values).toEqual({ choice: 'o1' });
  await inbox.agent.reply('ship', 'Understood. Two changes follow.');
  await expect(page.locator('nav.queue h3', { hasText: 'Agent replied' })).toBeVisible();
  await page.locator('.q', { hasText: 'Ship it?' }).click();
  await page.locator('.follow-up').getByRole('button', { name: 'Dismiss without telling the agent' }).click();
  await inbox.agent.reply('ship', 'Also, a third change.');
  await expect.poll(async () => (await cardDetail('ship')).card.replies.length).toBe(2);
  const stored = await cardDetail('ship');
  expect(stored.card.closed?.kind).toBe('dismissed');
  expect(stored.card.replies.at(-1)?.seenAt).toBeNull();
  // The saved reply leaves the card in Sent, and never under Agent replied.
  await expect(page.locator('nav.queue .q.dim', { hasText: 'Ship it?' })).toBeVisible();
  await expect(page.locator('nav.queue h3', { hasText: 'Agent replied' })).toHaveCount(0);
});

test('Reply on a replied card sends the comment with the earlier answer unchanged, and the form stays folded', async ({ page }) => {
  const heard = inbox.listen('s-merge');
  await inbox.agent.post({ id: 'merge', agent: 's-merge', title: 'Merge both?', priority: 'now', options: [{ id: 'o1', label: 'Merge' }, { id: 'o2', label: 'Wait' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Merge both?' }).click();
  await page.getByText('Merge', { exact: true }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => heard.events.filter((e) => e.type === 'answer').length).toBe(1);
  await inbox.agent.reply('merge', 'Do I also bump the version?');
  // The agent's reply opens a comment box of its own, and the answer form folds away.
  await expect(page.locator('.follow-up')).toBeVisible();
  await expect(page.locator('details.change-answer > summary')).toHaveText('Change your answer');
  await expect(page.locator('details.change-answer .openui-buttons')).toBeHidden();
  await page.locator('.follow-up textarea').fill('Yes, bump it.');
  await page.locator('.follow-up').getByRole('button', { name: 'Reply' }).click();
  await expect.poll(() => heard.events.filter((e) => e.type === 'answer').length).toBe(2);
  const second = heard.events.filter((e) => e.type === 'answer')[1];
  expect(second?.type === 'answer' && second.answer.comment).toBe('Yes, bump it.');
  expect(second?.type === 'answer' && second.answer.values).toEqual({ choice: 'o1' });
  const stored = await cardDetail('merge');
  expect(stored.answer?.previous.length).toBe(1);
  expect(stored.answer?.previous[0]?.values).toEqual({ choice: 'o1' });
});

test('a reply stays unseen until the person dismisses the card, replies, or changes the answer', async ({ page }) => {
  await inbox.agent.post({ id: 'waiting', agent: 's-waiting', title: 'Still needed?', priority: 'now' });
  await inbox.open(page);
  await expect(page.locator('.card-title')).toHaveText('Still needed?');
  await inbox.agent.reply('waiting', 'Ping about this one.');
  await expect(page.locator('.reply-msg')).toContainText('Ping about this one.');
  // The card stayed in front of the person, but looking is not seeing.
  await page.waitForTimeout(2500);
  expect(inbox.server.inbox.getCard('waiting').replies[0]?.seenAt).toBeNull();
  await expect(page.locator('nav.queue h3', { hasText: 'Agent replied' })).toBeVisible();
  await page.locator('.focus-card').getByRole('button', { name: 'Dismiss without telling the agent' }).click();
  await expect.poll(() => inbox.server.inbox.getCard('waiting').replies[0]?.seenAt).not.toBeNull();
  expect(inbox.server.inbox.getCard('waiting').closed?.kind).toBe('dismissed');
});
