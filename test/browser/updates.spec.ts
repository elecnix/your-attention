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

test('new page code waits while you type, and loads once you pause outside a field', async ({ page }) => {
  const box = await typing(page, 'code', 'Answer me while the page code changes');
  inbox.server.inbox.announceCode();
  await page.waitForTimeout(4000);
  await page.keyboard.type(' answer');
  await expect(box).toHaveValue('half of my answer');
  expect(await box.evaluate((el) => document.activeElement === el && (el as HTMLElement & { marked?: boolean }).marked === true)).toBe(true);
  const reload = page.waitForEvent('load');
  await page.locator('.focus-card .card-title').click();
  await reload;
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

test('a revision of the card you are typing on keeps your text and focus, and shows the new words', async ({ page }) => {
  const box = await typing(page, 'revise', 'Answer me while I change');
  await inbox.agent.post({ id: 'revise', agent: 's-revise', title: 'Answer me while I change', text: 'New context from the agent.', options: [{ id: 'o1', label: 'Yes' }], priority: 'now' });
  await expect(page.locator('.focus-card')).toContainText('New context from the agent.');
  await page.keyboard.type(' answer');
  await expect(box).toHaveValue('half of my answer');
  expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);
  const ev = inbox.listen('s-revise');
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const a = ev.events.find((e) => e.type === 'answer');
  expect(a?.type === 'answer' && [a.answer.comment, a.answer.version]).toEqual(['half of my answer', 2]);
});

test('a revision that relabels the option you picked drops that pick, and keeps your comment', async ({ page }) => {
  await inbox.agent.post({ id: 'relabel', agent: 's-relabel', title: 'Pick one while I relabel', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }], priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Pick one while I relabel' }).click();
  await page.locator('.focus-card').getByText('No', { exact: true }).click();
  await page.locator('.focus-card textarea').fill('my reason');
  await inbox.agent.post({ id: 'relabel', agent: 's-relabel', title: 'Pick one while I relabel', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'Maybe' }], priority: 'now' });
  await expect(page.locator('.focus-card').getByText('Maybe', { exact: true })).toBeVisible();
  const ev = inbox.listen('s-relabel');
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const a = ev.events.find((e) => e.type === 'answer');
  expect(a?.type === 'answer' && [a.answer.values['choice'], a.answer.comment]).toEqual([undefined, 'my reason']);
});
