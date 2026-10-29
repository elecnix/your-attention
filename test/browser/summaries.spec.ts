// GET /v1/state sends one summary per card. The page fetches the whole card it opens, and the card after it ahead of time,
// so Skip for now shows the next card at once.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('the state has no card text, and the page fetches the open card and the next one ahead', async ({ page }) => {
  await inbox.agent.post({ id: 'sum-1', agent: 's-sum', title: 'First of two', priority: 'now', text: `${'Context. '.repeat(50)}\n\nThe first card says this.` });
  await inbox.agent.post({ id: 'sum-2', agent: 's-sum', title: 'Second of two', priority: 'now', text: 'The second card says that.' });
  const fetched: string[] = [];
  let stateBody = '';
  page.on('response', async (r) => {
    const path = new URL(r.url()).pathname;
    if (path.endsWith('/v1/state')) stateBody = await r.text().catch(() => '');
    const m = /\/v1\/cards\/([^/]+)$/.exec(path);
    if (m && r.request().method() === 'GET') fetched.push(decodeURIComponent(m[1] ?? ''));
  });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'First of two' }).click();
  await expect(page.locator('.focus-card .card-text')).toContainText('The first card says this.');
  expect(stateBody).toContain('First of two');
  // The state previews the start of the text, for links, and leaves the rest out.
  expect(stateBody).not.toContain('The first card says this.');
  await expect.poll(() => fetched.includes('sum-2')).toBe(true);
  // The second card is in memory already, so it draws in the same frame as the click.
  await page.locator('.focus-card button', { hasText: 'Skip for now' }).click();
  await expect(page.locator('.focus-card .card-text')).toContainText('The second card says that.');
  await expect(page.locator('.focus-card[aria-busy="true"]')).toHaveCount(0);
});
