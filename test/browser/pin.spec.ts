// The PIN on the page: the offer to set one, Skip and Never ask again, the lock screen, and that each tab unlocks on its own.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox({ pinPrompt: true }); });
test.afterEach(async () => { await inbox.close(); });

/** Sign a page in, without waiting for the inbox: a locked page never connects. */
const signIn = (page: Page) => page.goto(`${inbox.server.url}/#token=${inbox.server.ownerToken}`);
const offer = (page: Page) => page.getByRole('form', { name: 'Set a PIN' });
const typePin = async (page: Page, pin: string) => {
  await page.getByLabel('New PIN').fill(pin);
  await page.getByLabel('Again').fill(pin);
  await page.getByRole('button', { name: 'Set PIN' }).click();
};

test('an inbox without a PIN offers one; Skip asks again on the next open, Never ask again does not', async ({ page }) => {
  await signIn(page);
  await expect(offer(page)).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(offer(page)).toBeHidden();
  await page.reload();
  await page.locator('.bar .pill.on').waitFor();
  await expect(offer(page)).toBeVisible();
  await page.getByRole('button', { name: 'Never ask again' }).click();
  await expect(offer(page)).toBeHidden();
  expect(inbox.server.inbox.pin.status().neverAsk).toBe(true);
  await page.reload();
  await page.locator('.bar .pill.on').waitFor();
  await expect(offer(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Set a PIN' })).toBeVisible();
});

test('setting a PIN keeps this tab open, and a new tab must unlock', async ({ page, browser }) => {
  await signIn(page);
  await typePin(page, '2468');
  await expect(offer(page)).toBeHidden();
  expect(inbox.server.inbox.pin.isSet()).toBe(true);
  // This tab stays unlocked, and its live connection comes back with the new token.
  await inbox.agent.post({ id: 'after-pin', agent: 'a1', title: 'Still here after the PIN?' });
  await expect(page.locator('.focus-card .card-title')).toHaveText('Still here after the PIN?');
  await expect(page.locator('.bar .pill.on')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unlock your inbox' })).toBeHidden();

  // Another browser context is another tab with its own session storage. The cookie alone opens nothing.
  const other = await browser.newContext();
  const tab = await other.newPage();
  await tab.goto(`${inbox.server.url}/#token=${inbox.server.ownerToken}`);
  await expect(tab.getByRole('heading', { name: 'Unlock your inbox' })).toBeVisible();
  await expect(tab.locator('.focus-card')).toHaveCount(0);
  await tab.getByLabel('PIN').fill('1111');
  await tab.getByRole('button', { name: 'Unlock' }).click();
  await expect(tab.getByRole('alert')).toContainText('4 tries left');
  await tab.getByLabel('PIN').fill('2468');
  await tab.getByRole('button', { name: 'Unlock' }).click();
  await expect(tab.locator('.focus-card .card-title')).toHaveText('Still here after the PIN?');
  await expect(tab.locator('.bar .pill.on')).toBeVisible();

  // Closing the tab clears its session storage: the next page load asks again.
  await tab.evaluate(() => sessionStorage.clear());
  await tab.reload();
  await expect(tab.getByRole('heading', { name: 'Unlock your inbox' })).toBeVisible();
  await other.close();
});

test('wrong PINs lock the screen and say how long to wait', async ({ page }) => {
  await inbox.server.inbox.pin.set('2468');
  await signIn(page);
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('PIN').fill('0000');
    await page.getByRole('button', { name: 'Unlock' }).click();
    if (i < 4) await expect(page.getByRole('alert')).toContainText(`${4 - i} ${4 - i === 1 ? 'try' : 'tries'} left`);
  }
  await expect(page.getByRole('status')).toContainText(/Too many wrong PINs\. Try again in \d+ seconds/);
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Too many wrong PINs', { timeout: 5000 });
});

test('a PIN reset on the computer locks every open tab, and Lock this tab locks this one', async ({ page }) => {
  await inbox.server.inbox.pin.set('2468');
  await signIn(page);
  await page.getByLabel('PIN').fill('2468');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.locator('.bar .pill.on').waitFor();
  await inbox.server.inbox.pin.set('1357');
  await expect(page.getByRole('heading', { name: 'Unlock your inbox' })).toBeVisible();
  await page.getByLabel('PIN').fill('1357');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.locator('.bar .pill.on').waitFor();
  await page.getByRole('button', { name: 'Lock this tab' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your inbox' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock your inbox' })).toBeVisible();
});

test('changing the PIN on the page needs the current one', async ({ page }) => {
  await inbox.server.inbox.pin.set('2468');
  await signIn(page);
  await page.getByLabel('PIN').fill('2468');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.locator('.bar .pill.on').waitFor();
  await page.getByRole('button', { name: 'Change PIN' }).click();
  const form = page.getByRole('form', { name: 'Change the PIN' });
  await form.getByLabel('Current PIN').fill('0000');
  await form.getByLabel('New PIN').fill('1357');
  await form.getByLabel('Again').fill('1357');
  await form.getByRole('button', { name: 'Change PIN' }).click();
  await expect(form.getByRole('alert')).toContainText('wrong PIN');
  await form.getByLabel('Current PIN').fill('2468');
  await form.getByRole('button', { name: 'Change PIN' }).click();
  await expect(form).toBeHidden();
  await expect(page.locator('.bar .pill.on')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unlock your inbox' })).toBeHidden();
});
