// The version the inbox runs, on hover over the GitHub mark, so a deployment can be told apart (SPEC.md, "Transport").
import { expect, test } from '@playwright/test';
import { VERSION } from '../../src/core/version.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('names the version on hover over the GitHub mark', async ({ page }) => {
  await inbox.open(page);
  const mark = page.locator('a.repo');
  await expect(mark).toHaveAttribute('title', `Your Attention ${VERSION} on GitHub`);
  // The state carries it, so a page that never asks /v1/info still knows which release it talks to.
  expect(await page.evaluate(async () => (await (await fetch('v1/state')).json()).version)).toBe(VERSION);
});
