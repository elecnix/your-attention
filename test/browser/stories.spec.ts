// Opens every story of the built Storybook and fails on a page error or an empty render.
// Run `npm run storybook:build` first.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const DIR = path.resolve('storybook-static');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
let server: http.Server;
let base = '';

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(DIR, 'index.json'))) throw new Error('Build the stories first: npm run storybook:build');
  server = http.createServer((req, res) => {
    const file = path.join(DIR, decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
    if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(() => { server?.close(); });

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
