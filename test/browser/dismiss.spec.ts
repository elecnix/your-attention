// Issue 38: dismiss a card without telling its agent. A card stored with replies keeps them in a fold.
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

test('a card stored with replies lists no Agent replied group, and dismissing it keeps the replies', async ({ page }) => {
  await inbox.agent.post({ id: 'waiting', agent: 's-waiting', title: 'Still needed?', priority: 'now' });
  inbox.seedReplies('waiting', ['Ping about this one.']);
  await inbox.open(page);
  await expect(page.locator('.card-title')).toHaveText('Still needed?');
  await expect(page.locator('nav.queue h3', { hasText: 'Agent replied' })).toHaveCount(0);
  await expect(page.locator('.reply-msg')).toContainText('Ping about this one.');
  await page.locator('.focus-card').getByRole('button', { name: 'Dismiss without telling the agent' }).click();
  await expect.poll(async () => (await cardDetail('waiting')).card.closed?.kind).toBe('dismissed');
  expect((await cardDetail('waiting')).card.replies.map((r) => r.text)).toEqual(['Ping about this one.']);
});
