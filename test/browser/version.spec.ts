// The build the inbox runs, on hover over the GitHub mark, so a deployment can be told apart (SPEC.md, "Transport").
import { expect, test } from '@playwright/test';
import { nodeBuild } from '../../src/node/build.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('names the version and commit on hover over the GitHub mark', async ({ page }) => {
  const { version, commit } = nodeBuild();
  await inbox.open(page);
  const mark = page.locator('a.repo');
  await expect(mark).toHaveAttribute('title', `Your Attention ${version}${commit ? ` (${commit.slice(0, 7)})` : ''} on GitHub`);
  // The accessible name stays the same, because a link's name is what a person hears, not what it runs.
  await expect(mark).toHaveAttribute('aria-label', 'Your Attention on GitHub');
  // The page reads it from GET /v1/info, which answers with the build the inbox runs.
  expect(await page.evaluate(async () => (await (await fetch('v1/info')).json()).version)).toBe(version);
});
