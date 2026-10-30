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

test('a file link on a card from another machine shows its path as code', async ({ page }) => {
  await inbox.agent.post({ id: 'file-there', agent: 's-files', title: 'A report on the build machine', priority: 'now', origin: { host: `not-${os.hostname()}` },
    text: 'The report is at [the report](file:///srv/build/report.html).' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A report on the build machine' }).click();
  await expect(page.locator('.focus-card .card-text code')).toHaveText('/srv/build/report.html');
  await expect(page.locator('.focus-card a.file-link')).toHaveCount(0);
});
