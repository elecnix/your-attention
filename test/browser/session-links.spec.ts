// A card can point at another agent's session with a herdr link, and a click focuses that session in herdr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
let calls: string;
test.beforeAll(async () => {
  // A stand-in for herdr that records each command it gets.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-herdr-'));
  calls = path.join(dir, 'calls');
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${calls}'\necho '{}'\n`, { mode: 0o755 });
  process.env['HERDR_BIN_PATH'] = bin;
  inbox = await startInbox();
});
test.afterAll(async () => { await inbox.close(); });
test.beforeEach(() => { fs.rmSync(calls, { force: true }); });

const focused = (): string[] => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);

test('a session link in the card text focuses that tab in herdr, and opens no page', async ({ page }) => {
  await inbox.agent.post({ id: 'link-text', agent: 's-orch', title: 'A blocked agent', priority: 'now',
    text: 'The release agent waits on a permission: [release agent](https://herdr.invalid/v1/tab/w7:t3).' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A blocked agent' }).click();
  const link = page.locator('.focus-card a.session-link', { hasText: 'release agent' });
  await expect(link).toBeVisible();
  const pages = page.context().pages().length;
  await link.click();
  await expect.poll(focused).toEqual(['tab focus w7:t3']);
  expect(page.context().pages().length).toBe(pages);
});

test('a session link in a body focuses that pane', async ({ page }) => {
  await inbox.agent.post({ id: 'link-body', agent: 's-orch', title: 'Two stuck agents', priority: 'now',
    body: 'root = Card([t])\nt = TextContent("See [the CI agent](https://herdr.invalid/v1/agent/w2:p5).")' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Two stuck agents' }).click();
  await page.locator('.focus-card a', { hasText: 'the CI agent' }).click();
  await expect.poll(focused).toEqual(['agent focus w2:p5']);
});

test('a session link in an HTML card focuses that workspace', async ({ page }) => {
  await inbox.agent.post({ id: 'link-html', agent: 's-orch', title: 'A workspace to look at', priority: 'now',
    html: '<p><a id=go href="https://herdr.invalid/v1/workspace/w9">the deploy workspace</a></p>' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A workspace to look at' }).click();
  await page.getByRole('button', { name: 'Show this card' }).click();
  const pages = page.context().pages().length;
  await page.frameLocator('iframe.html-card').locator('#go').click();
  await expect.poll(focused).toEqual(['workspace focus w9']);
  expect(page.context().pages().length).toBe(pages);
});
