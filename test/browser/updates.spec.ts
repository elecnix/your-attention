// Updates that arrive while the person types must leave the field, its text and its focus alone.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

async function typing(page: import('@playwright/test').Page, id: string, title: string) {
  await inbox.agent.post({ id, agent: `s-${id}`, title, options: [{ id: 'o1', label: 'Yes' }], priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: title }).click();
  const box = page.locator('.focus-card textarea');
  await box.click();
  await page.keyboard.type('half of my');
  await box.evaluate((el) => { (el as HTMLElement & { marked?: boolean }).marked = true; });
  return box;
}

test('cards that arrive, change or close while you type keep your field, its text and its focus', async ({ page }) => {
  const box = await typing(page, 'typing', 'Answer me while things happen');
  await inbox.agent.post({ id: 'other', agent: 's-other', title: 'Another card arrives', priority: 'now' });
  await inbox.agent.post({ id: 'other', agent: 's-other', title: 'Another card, revised', priority: 'now' });
  await inbox.agent.close('other', 'resolved', 'Done elsewhere.');
  await expect(page.locator('.q', { hasText: 'Another card, revised' })).toBeVisible();
  await page.keyboard.type(' answer');
  await expect(box).toHaveValue('half of my answer');
  expect(await box.evaluate((el) => document.activeElement === el && (el as HTMLElement & { marked?: boolean }).marked === true)).toBe(true);
});

test('new page code waits for you: the page offers a reload and does not reload under your typing', async ({ page }) => {
  const box = await typing(page, 'code', 'Answer me while the page code changes');
  inbox.server.inbox.announceCode();
  await expect(page.locator('.code-update')).toBeVisible();
  await page.keyboard.type(' answer');
  await expect(box).toHaveValue('half of my answer');
  expect(await box.evaluate((el) => document.activeElement === el && (el as HTMLElement & { marked?: boolean }).marked === true)).toBe(true);
  await page.locator('.code-update button', { hasText: 'Reload' }).click();
  await expect(page.locator('.code-update')).toHaveCount(0);
  await expect(page.locator('.focus-card textarea')).toHaveValue('half of my answer');
});

test('new page code loads at once in a tab you are not looking at', async ({ page }) => {
  await inbox.open(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    (window as unknown as { reloaded?: boolean }).reloaded = false;
  });
  const reload = page.waitForEvent('load');
  inbox.server.inbox.announceCode();
  await reload;
});
