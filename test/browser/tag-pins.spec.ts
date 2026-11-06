// A pinned tag value gets its own group at the top of the queue. The person pins from a tag on the card, or from a group heading
// under a tag grouping, and the pins stay on this device next to Group by.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  await inbox.agent.post({ id: 'tp-invoice', agent: 's-tp', title: 'Ship the invoice fix?', priority: 'now', tags: { topic: 'billing', repo: 'acme/api' } });
  await inbox.agent.post({ id: 'tp-refund', agent: 's-tp', title: 'Refund the duplicate charge?', priority: 'soon', tags: { topic: 'billing' } });
  await inbox.agent.post({ id: 'tp-search', agent: 's-tp', title: 'Rebuild the search index?', priority: 'now', tags: { topic: 'search', repo: 'acme/api' } });
  await inbox.agent.post({ id: 'tp-plain', agent: 's-tp', title: 'Rename the branch?', priority: 'now' });
});
test.afterAll(async () => { await inbox.close(); });

const heading = (page: Page, name: string) => page.locator('.queue h3', { hasText: name });
// The heading's name, without the triangle that opens and collapses its group.
const headings = (page: Page) => page.locator('.queue h3 .fold-name').allInnerTexts();
const groupOf = (page: Page, title: string) => page.locator('.queue .q', { hasText: title }).evaluate((el) => {
  let n = el.previousElementSibling;
  while (n && n.tagName !== 'H3') n = n.previousElementSibling;
  return n ? (n.textContent || '').trim() : '';
});

test('the card shows its tags, each with a dimmed pin right after its value', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Ship the invoice fix?' }).click();
  const tag = page.locator('.focus-card .tags .tag', { hasText: 'topic: billing' });
  await expect(tag).toBeVisible();
  const pin = tag.getByRole('button', { name: 'Pin topic: billing to the top' });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  // The pin sits right after the label text, not at the left and not at the far right.
  const [text, button] = await Promise.all([tag.locator('.tag-label').boundingBox(), pin.boundingBox()]);
  expect(button!.x).toBeGreaterThan(text!.x + text!.width - 1);
  expect(button!.x - (text!.x + text!.width)).toBeLessThan(12);
  const dim = await pin.evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(dim).toBeLessThan(0.7);
});

test('pinning from the card puts the value in its own group at the top, and the pin turns bright', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Ship the invoice fix?' }).click();
  await page.locator('.focus-card .tags').getByRole('button', { name: 'Pin topic: billing to the top' }).click();
  const unpin = page.locator('.focus-card .tags').getByRole('button', { name: 'Unpin topic: billing' });
  await expect(unpin).toHaveAttribute('aria-pressed', 'true');
  expect(await unpin.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  expect((await headings(page))[0]?.toLowerCase()).toBe('topic: billing');
  await expect(heading(page, 'topic: billing').getByRole('button', { name: 'Unpin topic: billing' })).toHaveAttribute('aria-pressed', 'true');
  expect(await groupOf(page, 'Ship the invoice fix?')).toMatch(/topic: billing/i);
  expect(await groupOf(page, 'Refund the duplicate charge?')).toMatch(/topic: billing/i);
  // Each card shows once.
  await expect(page.locator('.queue .q', { hasText: 'Ship the invoice fix?' })).toHaveCount(1);
  // The pins stay on this device, next to Group by.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tagPins') || 'null'))).toEqual([['topic', 'billing']]);
  await page.reload();
  await page.locator('.bar .pill.on').waitFor();
  expect((await headings(page))[0]?.toLowerCase()).toBe('topic: billing');
  // Skip for now follows the queue as drawn, so the pinned cards come first.
  await page.locator('.q', { hasText: 'Ship the invoice fix?' }).click();
  await page.locator('.focus-card button', { hasText: 'Skip for now' }).click();
  await expect(page.locator('.card-title')).toHaveText('Refund the duplicate charge?');
  await heading(page, 'topic: billing').getByRole('button', { name: 'Unpin topic: billing' }).click();
  await expect(heading(page, 'topic: billing')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tagPins') || 'null'))).toEqual([]);
});

test('under a tag grouping, a group heading pins its value, and a card that matches two pins goes to the oldest', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.group-by select').selectOption('tag:repo');
  const pin = heading(page, 'acme/api').getByRole('button', { name: 'Pin repo: acme/api to the top' });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  expect((await headings(page))[0]?.toLowerCase()).toBe('repo: acme/api');
  // The heading that has no value offers no pin.
  await expect(heading(page, 'No repo').getByRole('button', { name: /^Pin / })).toHaveCount(0);
  await page.locator('.group-by select').selectOption('tag:topic');
  await heading(page, 'billing').getByRole('button', { name: 'Pin topic: billing to the top' }).click();
  expect((await headings(page)).slice(0, 2).map((t) => t.toLowerCase())).toEqual(['repo: acme/api', 'topic: billing']);
  expect(await groupOf(page, 'Ship the invoice fix?')).toMatch(/repo: acme\/api/i);
  expect(await groupOf(page, 'Refund the duplicate charge?')).toMatch(/topic: billing/i);
  // The pinned groups stay in place under every Group by choice.
  await page.locator('.group-by select').selectOption('priority');
  expect((await headings(page)).slice(0, 2).map((t) => t.toLowerCase())).toEqual(['repo: acme/api', 'topic: billing']);
  await page.evaluate(() => localStorage.removeItem('tagPins'));
});

test('a pinned group with nothing waiting keeps its heading, so the person can remove the pin', async ({ page }) => {
  await inbox.open(page);
  await page.evaluate(() => localStorage.setItem('tagPins', JSON.stringify([['topic', 'payroll']])));
  await page.reload();
  await page.locator('.bar .pill.on').waitFor();
  await expect(heading(page, 'topic: payroll')).toBeVisible();
  expect(await page.locator('.queue h3').first().evaluate((el) => el.nextElementSibling?.textContent)).toBe('Nothing waiting');
  await heading(page, 'topic: payroll').getByRole('button', { name: 'Unpin topic: payroll' }).click();
  await expect(heading(page, 'topic: payroll')).toHaveCount(0);
});
