// A card on the laptop inbox can name a file on this machine with a file: address. The page shows it as a chip, and a
// click opens the file in a new tab, at a folder ticket's address where an HTML file's images and stylesheet load too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
let report: string;
let site: string;
// A one-pixel PNG, as a file in the report's folder and as a data: address in its HTML.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
test.beforeAll(async () => {
  inbox = await startInbox();
  report = path.join(inbox.home, 'My Report.html');
  fs.writeFileSync(report, '<h1>Weekly report</h1><script>document.body.append("script ran")</script>');
  site = path.join(inbox.home, 'site');
  fs.mkdirSync(path.join(site, 'img'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<link rel="stylesheet" href="style.css"><h1>Site report</h1>'
    + `<img id="file" src="img/logo.png"><img id="inline" src="data:image/png;base64,${PIXEL}">`
    + '<script>document.body.append("script ran")</script>');
  fs.writeFileSync(path.join(site, 'style.css'), 'h1 { color: rgb(1, 2, 3); }');
  fs.writeFileSync(path.join(site, 'img', 'logo.png'), Buffer.from(PIXEL, 'base64'));
});
test.afterAll(async () => { await inbox.close(); });

test('a file link on a card from this machine is a chip with the file name, the path on hover, and a Copy path button', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await inbox.agent.post({ id: 'file-chip', agent: 's-files', title: 'Read the chip report', priority: 'now', origin: { host: os.hostname() },
    text: `The report is at [the report](${pathToFileURL(report).href}).` });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the chip report' }).click();
  const chip = page.locator('.focus-card .file-chip');
  await expect(chip.locator('a.file-link')).toHaveText('My Report.html');
  await expect(chip.locator('a.file-link')).toHaveAttribute('title', report);
  await chip.getByRole('button', { name: 'Copy path' }).click();
  await expect(chip.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(report);
});

test('a file link on a card from this machine opens the file in a new tab, where its scripts do not run', async ({ page }) => {
  await inbox.agent.post({ id: 'file-here', agent: 's-files', title: 'Read the weekly report', priority: 'now', origin: { host: os.hostname() },
    text: `The report is at ${pathToFileURL(report).href}.` });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the weekly report' }).click();
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.locator('.focus-card a.file-link').click()]);
  await expect(tab.locator('h1')).toHaveText('Weekly report');
  await expect(tab.locator('body')).not.toContainText('script ran');
});

test('an HTML file opens with the stylesheet and image in its folder and the image it embeds, and its script does not run', async ({ page }) => {
  await inbox.agent.post({ id: 'file-site', agent: 's-files', title: 'Read the site report', priority: 'now', origin: { host: os.hostname() },
    text: `The report is at ${pathToFileURL(path.join(site, 'index.html')).href}.` });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the site report' }).click();
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.locator('.focus-card a.file-link').click()]);
  await expect(tab.locator('h1')).toHaveText('Site report');
  expect(new URL(tab.url()).pathname).toMatch(/^\/v1\/files\/[0-9a-f]+\/index\.html$/);
  await expect(tab.locator('h1')).toHaveCSS('color', 'rgb(1, 2, 3)');
  for (const id of ['file', 'inline']) {
    await expect.poll(() => tab.locator(`#${id}`).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { message: id }).toBe(1);
  }
  await expect(tab.locator('body')).not.toContainText('script ran');
});

test('with a PIN, a file link opens in a new tab with a ticket from the unlocked page', async ({ page }) => {
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
    expect(new URL(tab.url()).pathname).toMatch(/^\/v1\/files\//);
    // The ticket works while the page that asked for it stays unlocked, so the tab reloads.
    expect((await tab.reload())?.status()).toBe(200);
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
