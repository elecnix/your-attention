// Pinning an agent puts every card that agent posted in a group at the top of the queue, beside the pins on tag values.
// The pin sits on the agent chip under the meta row, and the heading names the session the inbox knows.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  await inbox.agent.post({ id: 'ap-beta', agent: 's-beta', title: 'Ship the beta fix?', priority: 'now', origin: { name: 'Beta session' } });
  await inbox.agent.post({ id: 'ap-alpha', agent: 's-alpha', title: 'Ship the alpha fix?', priority: 'soon', origin: { name: 'Alpha session' } });
  await inbox.agent.post({ id: 'ap-alpha-two', agent: 's-alpha', title: 'Refund the alpha charge?', priority: 'later', origin: { name: 'Alpha session' }, tags: { topic: 'billing' } });
  await inbox.agent.post({ id: 'ap-nameless', agent: 's-gamma', title: 'Rename the gamma branch?', priority: 'later' });
});
test.afterAll(async () => { await inbox.close(); });

const heading = (page: Page, name: string) => page.locator('.queue h3', { hasText: name });
const headings = (page: Page) => page.locator('.queue h3 .fold-name').allInnerTexts();
const groupOf = (page: Page, title: string) => page.locator('.queue .q', { hasText: title }).evaluate((el) => {
  let n = el.previousElementSibling;
  while (n && n.tagName !== 'H3') n = n.previousElementSibling;
  return n ? (n.textContent || '').trim() : '';
});

test('the card shows its agent, with a dimmed pin right after the name', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Refund the alpha charge?' }).click();
  const chip = page.locator('.focus-card .tags .tag.agent');
  await expect(chip).toContainText('Agent: Alpha session');
  const pin = chip.getByRole('button', { name: 'Pin agent Alpha session to the top' });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  expect(await pin.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.7);
  // The tag pin of the same card sits in the same row, so the two controls read together.
  await expect(page.locator('.focus-card .tags .tag', { hasText: 'topic: billing' }).getByRole('button', { name: 'Pin topic: billing to the top' })).toBeVisible();
});

test('pinning the agent puts every card it posted at the top, including one with no tags, and unpinning restores the order', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Ship the alpha fix?' }).click();
  await page.locator('.focus-card .tags .tag.agent').getByRole('button', { name: 'Pin agent Alpha session to the top' }).click();
  const unpin = page.locator('.focus-card .tags .tag.agent').getByRole('button', { name: 'Unpin agent Alpha session' });
  await expect(unpin).toHaveAttribute('aria-pressed', 'true');
  expect(await unpin.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  // The heading names the session, and both alpha cards sit under it, the one without tags included.
  expect((await headings(page))[0]?.toLowerCase()).toBe('alpha session');
  expect(await groupOf(page, 'Ship the alpha fix?')).toMatch(/Alpha session/i);
  expect(await groupOf(page, 'Refund the alpha charge?')).toMatch(/Alpha session/i);
  expect(await groupOf(page, 'Ship the beta fix?')).not.toMatch(/Alpha session/i);
  await expect(page.locator('.queue .q', { hasText: 'Ship the alpha fix?' })).toHaveCount(1);
  // The pins are the inbox's settings, so another page and the terminal client share them.
  expect(inbox.server.inbox.settings().pins).toEqual([{ agent: 's-alpha' }]);
  await page.reload();
  await page.locator('.bar .pill.on').waitFor();
  expect((await headings(page))[0]?.toLowerCase()).toBe('alpha session');
  // The heading's own pin removes it, and the queue returns to its priority order.
  await heading(page, 'Alpha session').getByRole('button', { name: 'Unpin agent Alpha session' }).click();
  await expect(heading(page, 'Alpha session')).toHaveCount(0);
  expect(inbox.server.inbox.settings().pins).toEqual([]);
  const titles = await page.locator('.queue .q .t-title').allInnerTexts();
  expect(titles.findIndex((t) => t.includes('Ship the beta fix?'))).toBeLessThan(titles.findIndex((t) => t.includes('Ship the alpha fix?')));
});

test('an agent with no session name is pinned and named by its id', async ({ page }) => {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Rename the gamma branch?' }).click();
  const chip = page.locator('.focus-card .tags .tag.agent');
  await expect(chip).toContainText('Agent: s-gamma');
  await chip.getByRole('button', { name: 'Pin agent s-gamma to the top' }).click();
  // The pin and the redraw are two steps, so the queue is read once the chip says the agent is pinned.
  await expect(page.locator('.focus-card .tags .tag.agent').getByRole('button', { name: 'Unpin agent s-gamma' })).toHaveAttribute('aria-pressed', 'true');
  expect((await headings(page))[0]?.toLowerCase()).toBe('s-gamma');
  expect(await groupOf(page, 'Rename the gamma branch?')).toMatch(/s-gamma/);
  await heading(page, 's-gamma').getByRole('button', { name: 'Unpin agent s-gamma' }).click();
  await expect(heading(page, 's-gamma')).toHaveCount(0);
});
