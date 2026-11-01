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

test('signs a device out on an inbox with a PIN, because every page call carries its unlock token', async ({ page }) => {
  // On a PIN inbox the list and the delete both need the tab's unlock token. The page adds it to every same-origin
  // request in web/env.js, so a raw fetch from the page has it too, and this case pins that: it would fail with 423.
  await inbox.server.inbox.pin.set('2468');
  const phone = 'Nicolas’s phone';
  const { token } = await inbox.server.inbox.createToken(phone, 'owner');
  await page.goto(`${inbox.server.url}/#token=${inbox.server.ownerToken}`);
  await page.getByLabel('PIN').fill('2468');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.locator('.bar .pill.on').waitFor();
  await page.getByRole('button', { name: 'Devices signed in to this inbox' }).click();
  const dialog = page.getByRole('dialog', { name: 'Devices signed in to this inbox' });
  await expect(dialog).toContainText(phone);
  const row = dialog.locator('li', { hasText: phone });
  await row.getByRole('button', { name: 'Sign out' }).click();
  await row.getByRole('button', { name: 'Sign it out' }).click();
  await expect(dialog).not.toContainText(phone);
  const tokens = await (await fetch(`${inbox.server.url}/v1/tokens`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } })).json() as { name: string }[];
  expect(tokens.some((t) => t.name === phone)).toBe(false);

  // The gate is real, and the page clears it only through the unlock header that web/env.js adds: a request without it
  // is refused, so this case fails if the page ever stops sending the token.
  const refused = await page.evaluate((id) => new Promise<number>((resolve) => {
    const x = new XMLHttpRequest();
    x.open('DELETE', `v1/tokens/${encodeURIComponent(id)}`);
    x.setRequestHeader('x-your-attention', '1');
    x.onload = () => resolve(x.status);
    x.onerror = () => resolve(-1);
    x.send();
  }), token.id);
  expect(refused).toBe(423);
});
