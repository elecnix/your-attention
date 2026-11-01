// The devices dialog: every key to this inbox, and signing one out.
import os from 'node:os';
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

test('lists the keys to this inbox, and signs one device out after asking', async ({ page }) => {
  // A phone that signed in earlier, as the phone dialog leaves behind.
  const phone = 'device signed in 2026-11-01 10:00';
  await inbox.server.inbox.createToken(phone, 'owner');
  await inbox.open(page);
  await page.getByRole('button', { name: 'Devices signed in to this inbox' }).click();
  const dialog = page.getByRole('dialog', { name: 'Devices signed in to this inbox' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(phone);
  await expect(dialog).toContainText(`page on ${os.hostname()}`);

  const row = dialog.locator('li', { hasText: phone });
  // Signing out asks first, and keeping the device leaves the row as it was.
  await row.getByRole('button', { name: 'Sign out' }).click();
  await expect(row).toContainText('It loses its key');
  await row.getByRole('button', { name: 'Keep it' }).click();
  await expect(row.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await row.getByRole('button', { name: 'Sign out' }).click();
  await row.getByRole('button', { name: 'Sign it out' }).click();
  await expect(dialog).not.toContainText(phone);

  // The key of the tab that did the revoking still works, and the inbox no longer knows the phone.
  const tokens = await (await fetch(`${inbox.server.url}/v1/tokens`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } })).json() as { name: string }[];
  expect(tokens.some((t) => t.name === phone)).toBe(false);
  expect(tokens.some((t) => t.name === `page on ${os.hostname()}`)).toBe(true);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
