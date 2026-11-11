// The search field in the bar: ⌘K (Ctrl+K elsewhere) focuses it, and typing filters the queue in the browser over the card
// summaries and the whole cards the page has fetched. Typing never asks the inbox for anything.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  await inbox.agent.post({ id: 'cs-invoice', agent: 's-cs', title: 'Ship the invoice fix?', text: 'Short.', priority: 'now', tags: { topic: 'billing' } });
  await inbox.agent.post({ id: 'cs-long', agent: 's-cs', title: 'Pick a cache layer', text: `${'Background paragraph. '.repeat(30)}The zebra benchmark favours Redis.`, priority: 'later' });
  await inbox.agent.post({ id: 'cs-region', agent: 's-cs', title: 'Which region?', text: 'Latency only.', priority: 'soon', tags: { repo: 'acme/api' } });
  await inbox.agent.post({ id: 'cs-done', agent: 's-cs', title: 'Rename the branch?', priority: 'later' });
  await fetch(`${inbox.server.url}/v1/cards/cs-done/answer`, { method: 'POST', headers: { authorization: `Bearer ${inbox.server.ownerToken}`, 'content-type': 'application/json', 'x-your-attention': '1' }, body: JSON.stringify({ values: {}, comment: 'Use the quokka name.', version: 1 }) });
});
test.afterAll(async () => { await inbox.close(); });

const search = (page: Page) => page.getByRole('searchbox', { name: 'Search cards' });
const titles = (page: Page) => page.locator('.queue .q .t-title').allInnerTexts();

test('the bar has a quiet search field, and the shortcut focuses it', async ({ page }) => {
  await inbox.open(page);
  await expect(search(page)).toBeVisible();
  await expect(search(page)).not.toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search(page)).toBeFocused();
  // The field sits in the bar beside the other controls, and is no taller than the status pill.
  const [field, pill] = await Promise.all([search(page).boundingBox(), page.locator('.status-pill').boundingBox()]);
  expect(field!.y).toBeLessThan(80);
  expect(field!.height).toBeLessThanOrEqual(pill!.height + 12);
});

test('a title match filters the queue and highlights the match', async ({ page }) => {
  await inbox.open(page);
  await search(page).fill('INVOICE');
  expect(await titles(page)).toEqual(['Ship the invoice fix?']);
  await expect(page.locator('.queue .q mark')).toHaveText('invoice');
  await expect(page.locator('.queue [role=status]')).toHaveText('1 card matches');
});

test('a tag match finds the card', async ({ page }) => {
  await inbox.open(page);
  await search(page).fill('acme/api');
  expect(await titles(page)).toEqual(['Which region?']);
});

test('a match in the whole text of an opened card shows a snippet, and a card never opened is found by its summary only', async ({ page }) => {
  await inbox.open(page);
  await search(page).fill('zebra');
  await expect(page.locator('.queue .q')).toHaveCount(0);
  await expect(page.locator('.queue [role=status]')).toHaveText('No card matches');
  await search(page).fill('');
  await page.locator('.q', { hasText: 'Pick a cache layer' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('Pick a cache layer');
  await search(page).fill('zebra');
  expect(await titles(page)).toEqual(['Pick a cache layer']);
  await expect(page.locator('.queue .q .snippet')).toContainText('The zebra benchmark favours Redis.');
  await expect(page.locator('.queue .q .snippet mark')).toHaveText('zebra');
});

test('a match in an answer comment finds the card in Sent', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Rename the branch?' }).click();
  await expect(page.locator('.focus-card .note.ok')).toContainText('quokka');
  await search(page).fill('quokka');
  expect(await titles(page)).toEqual(['Rename the branch?']);
  await expect(page.locator('.queue .q .snippet')).toContainText('Use the quokka name.');
});

test('a result opens its card', async ({ page }) => {
  await inbox.open(page);
  await search(page).fill('region');
  await page.locator('.queue .q', { hasText: 'Which region?' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('Which region?');
  await expect(search(page)).toHaveValue('region');
});

test('typing sends no request to the inbox', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Pick a cache layer' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('Pick a cache layer');
  // Let the ahead-of-time fetches of the neighbours finish before counting.
  await page.waitForTimeout(500);
  const seen: string[] = [];
  page.on('request', (r) => seen.push(r.url()));
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('zebra benchmark', { delay: 15 });
  await expect(page.locator('.queue .q')).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(seen.filter((u) => u.startsWith(inbox.server.url) && !u.includes('/v1/person/'))).toEqual([]);
});

test('Escape clears the field and returns focus to where it was', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Which region?' }).click();
  const comment = page.locator('.focus-card textarea').first();
  await comment.fill('half a thought');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search(page)).toBeFocused();
  await page.keyboard.type('invoice');
  await expect(page.locator('.queue .q')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(search(page)).toHaveValue('');
  await expect(comment).toBeFocused();
  await expect(comment).toHaveValue('half a thought');
  expect((await titles(page)).length).toBe(4);
});
