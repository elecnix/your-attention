// Opens every story of the built Storybook and fails on a page error or an empty render.
// Run `npm run storybook:build` first.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { STORIES_DIR as DIR, serveStories } from './stories-server.ts';

let storybook: Awaited<ReturnType<typeof serveStories>> | undefined;
let base = '';

test.beforeAll(async () => {
  storybook = await serveStories();
  base = storybook.base;
});
test.afterAll(() => { storybook?.close(); });

const index = fs.existsSync(path.join(DIR, 'index.json'))
  ? (JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')) as { entries: Record<string, { id: string; type: string; title: string; name: string }> }).entries
  : {};
const stories = Object.values(index).filter((e) => e.type === 'story');

test('the Storybook has stories', () => {
  expect(stories.length).toBeGreaterThan(10);
});

for (const s of stories) {
  test(`story ${s.title} / ${s.name} renders without errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/iframe.html?id=${s.id}&viewMode=story`);
    await expect(page.locator('#storybook-root > *').first()).toBeVisible();
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
  });
}
