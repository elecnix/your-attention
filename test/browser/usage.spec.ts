import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox({ usage: true }); });
test.afterAll(async () => { await inbox.close(); });

const status = async () => (await (await fetch(`${inbox.server.url}/v1/telemetry`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } })).json()) as { enabled: boolean; notified: boolean };

test('the page tells the person about usage counts before any is sent, and turns them off', async ({ page }) => {
  await inbox.open(page);
  const notice = page.getByRole('region', { name: 'Usage counts' });
  await expect(notice).toContainText('never sends card text');
  await notice.getByText('The next report').click();
  await expect(notice.locator('pre')).toContainText('"cards"');
  expect((await status()).notified).toBe(false);
  await page.reload();
  await expect(notice, 'the notice stays until the person picks').toBeVisible();
  await notice.getByRole('button', { name: 'Turn usage counts off' }).click();
  await expect(notice).toBeHidden();
  expect(await status()).toMatchObject({ enabled: false, notified: true });
  const toggle = page.getByRole('switch', { name: 'Send usage counts' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(async () => (await status()).enabled).toBe(true);
  await page.reload();
  await expect(page.locator('.usage-notice')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Send usage counts' })).toBeChecked();
});
