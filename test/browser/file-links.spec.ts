// A card on the laptop inbox can name a file on this machine with a file: address, and a click opens the file in a new tab.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
let report: string;
test.beforeAll(async () => {
  inbox = await startInbox();
  report = path.join(inbox.home, 'My Report.html');
  fs.writeFileSync(report, '<h1>Weekly report</h1><script>document.body.append("script ran")</script>');
});
test.afterAll(async () => { await inbox.close(); });

test('a file link on a card from this machine opens the file in a new tab, where its scripts do not run', async ({ page }) => {
  await inbox.agent.post({ id: 'file-here', agent: 's-files', title: 'Read the weekly report', priority: 'now', origin: { host: os.hostname() },
    text: `The report is at ${pathToFileURL(report).href}.` });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the weekly report' }).click();
  const link = page.locator('.focus-card a.file-link');
  await expect(link).toHaveText(decodeURIComponent(pathToFileURL(report).pathname));
  const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await expect(tab.locator('h1')).toHaveText('Weekly report');
  await expect(tab.locator('body')).not.toContainText('script ran');
});

test('with a PIN, a file link opens in a new tab with a ticket from the unlocked page, once', async ({ page }) => {
  await inbox.agent.post({ id: 'file-pin', agent: 's-files', title: 'Read the locked report', priority: 'now', origin: { host: os.hostname() },
    text: `The report is at ${pathToFileURL(report).href}.` });
  await inbox.server.inbox.pin.set('2468');
  try {
    await page.goto(`${inbox.server.url}/#token=${inbox.server.ownerToken}`);
    await page.getByLabel('PIN').fill('2468');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.locator('.q', { hasText: 'Read the locked report' }).click();
    const [tab] = await Promise.all([page.context().waitForEvent('page'), page.locator('.focus-card a.file-link').click()]);
    await expect(tab.locator('h1')).toHaveText('Weekly report');
    expect(new URL(tab.url()).searchParams.has('ticket')).toBe(true);
    // The address in the tab works once, so a copy of it opens nothing.
    expect((await tab.reload())?.status()).toBe(403);
  } finally {
    inbox.server.inbox.pin.clear();
  }
});

test('a file link to a file that is gone says so in the new tab', async ({ page }) => {
  await inbox.agent.post({ id: 'file-gone', agent: 's-files', title: 'Read the missing report', priority: 'now', origin: { host: os.hostname() },
    text: `The report is at ${pathToFileURL(path.join(inbox.home, 'gone.html')).href}.` });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the missing report' }).click();
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.locator('.focus-card a.file-link').click()]);
  await expect(tab.locator('body')).toHaveText('The file did not open: no such file');
});

test('a file link on a card from another machine shows its path as code', async ({ page }) => {
  await inbox.agent.post({ id: 'file-there', agent: 's-files', title: 'A report on the build machine', priority: 'now', origin: { host: `not-${os.hostname()}` },
    text: 'The report is at [the report](file:///srv/build/report.html).' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A report on the build machine' }).click();
  await expect(page.locator('.focus-card .card-text code')).toHaveText('/srv/build/report.html');
  await expect(page.locator('.focus-card a.file-link')).toHaveCount(0);
});
