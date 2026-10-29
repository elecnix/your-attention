import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox({ usage: true }); });
test.afterAll(async () => { await inbox.close(); });

const status = async () => (await (await fetch(`${inbox.server.url}/v1/telemetry`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } })).json()) as { enabled: boolean; notified: boolean };

test('the laptop page offers usage counts, which stay off until the person turns them on', async ({ page }) => {
  await inbox.open(page);
  const notice = page.getByRole('region', { name: 'Usage counts' });
  await expect(notice).toContainText('Usage counts are off');
  await expect(notice).toContainText('anonymous');
  await notice.getByText('The next report').click();
  await expect(notice.locator('pre')).toContainText('"cards"');
  expect(await status()).toMatchObject({ enabled: false, notified: false });
  await page.reload();
  await expect(notice, 'the offer stays until the person picks').toBeVisible();
  await notice.getByRole('button', { name: 'Turn usage counts on' }).click();
  await expect(notice).toBeHidden();
  expect(await status()).toMatchObject({ enabled: true, notified: true });
  const toggle = page.getByRole('switch', { name: 'Send anonymous usage counts' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(async () => (await status()).enabled).toBe(false);
  await page.reload();
  await expect(page.locator('.usage-notice')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Send anonymous usage counts' })).not.toBeChecked();
});
