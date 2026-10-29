// The page on a phone, and the QR code that brings the inbox there.
import { devices, expect, test, type Page } from '@playwright/test';
import * as jsqr from 'jsqr';
import { startInbox, type TestInbox } from './inbox.ts';

// jsQR is a CommonJS package; its function is the default export, once or twice wrapped depending on the loader.
type Decode = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const unwrap = (m: unknown): Decode => (typeof m === 'function' ? (m as Decode) : unwrap((m as { default: unknown }).default));
const jsQR = unwrap(jsqr);

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

/** Draw the QR code's SVG on a canvas and decode it, as a phone camera would read it. */
async function readQr(page: Page): Promise<string | undefined> {
  const svg = page.locator('.qr svg');
  await expect(svg).toBeVisible();
  const { width, height, data } = await svg.evaluate(async (el) => {
    const img = new Image();
    img.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(el))}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 400;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, 400, 400);
    return { width: 400, height: 400, data: [...g.getImageData(0, 0, 400, 400).data] };
  });
  return jsQR(Uint8ClampedArray.from(data), width, height)?.data;
}

test('the phone button shows a QR code of the inbox address with a one-time sign-in code, never the owner token', async ({ page }) => {
  await inbox.open(page);
  const phone = page.getByRole('button', { name: 'Open this inbox on your phone' });
  const repo = page.getByRole('link', { name: 'Your Attention on GitHub' });
  // The phone button sits just left of the GitHub mark.
  const [p, r] = [await phone.boundingBox(), await repo.boundingBox()];
  expect(p!.x + p!.width).toBeLessThanOrEqual(r!.x);
  await phone.click();
  const dialog = page.getByRole('dialog', { name: 'Open this inbox on your phone' });
  await expect(dialog).toBeVisible();
  expect(await readQr(page)).toMatch(new RegExp(`^${inbox.server.url}/#signin=[0-9a-f]{32}$`));
  await expect(dialog.locator('.qr-address')).toHaveText(`${inbox.server.url}/`);
  // The test inbox listens on 127.0.0.1, which a phone cannot reach.
  await expect(dialog).toContainText('a phone cannot open it');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test.describe('on an iPhone', () => {
  // The iPhone's screen, touch and user agent, in the Chromium the suite runs.
  const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15'];
  test.use(iphone);

  test('the card and the queue scroll as one page, and a tapped title brings its card to the top', async ({ page }) => {
    const own = await startInbox();
    try {
      for (let i = 0; i < 12; i++) await own.agent.post({ id: `tall-${i}`, agent: `tall-${i % 3}`, title: `Tall question ${i}`, text: 'A line\n'.repeat(30), priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
      await own.open(page);
      await expect(page.locator('nav.queue button.q').first()).toBeVisible();
      // Nothing scrolls inside the page: the queue grows with its cards.
      const inner = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2).map((e) => e.className));
      expect(inner).toEqual([]);
      const pick = page.locator('nav.queue button.q').nth(6);
      const title = ((await pick.locator('.t').textContent()) ?? '').replace(/Decide now|new/g, '').trim();
      await pick.tap();
      await expect(page.locator('.focus-card h2').first()).toContainText(title);
      await expect.poll(async () => Math.abs(await page.locator('.focus-card').evaluate((e) => e.getBoundingClientRect().top))).toBeLessThan(20);
    } finally {
      await own.close();
    }
  });

  test('the page fits the screen, and the bar, notices and fields suit a phone', async ({ page }) => {
    await inbox.agent.post({ id: 'phone-1', agent: 'phone-offline', title: 'Which option on the phone?', priority: 'now', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
    await inbox.agent.post({ id: 'phone-2', agent: 'phone-offline', title: 'A second question', priority: 'soon' });
    await inbox.open(page);
    await expect(page.getByText('Which option on the phone?').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
    // The bar scrolls away with the page, and the title, the status dot and both links share its first row.
    expect(await page.locator('.bar').evaluate((e) => getComputedStyle(e).position)).toBe('static');
    const title = await page.locator('.bar h1').boundingBox();
    for (const sel of ['.status-pill', 'button.phone', 'a.repo']) {
      const box = await page.locator(sel).boundingBox();
      expect(Math.abs(box!.y + box!.height / 2 - (title!.y + title!.height / 2)), sel).toBeLessThan(12);
    }
    for (const sel of ['button.phone', 'a.repo']) {
      const box = await page.locator(sel).boundingBox();
      expect(box!.width, sel).toBeGreaterThanOrEqual(44);
      expect(box!.height, sel).toBeGreaterThanOrEqual(44);
    }
    // A long notice wraps inside the card.
    const card = await page.locator('main').boundingBox();
    const notice = await page.locator('main .pill.off').first().boundingBox();
    expect(notice!.x + notice!.width).toBeLessThanOrEqual(card!.x + card!.width);
    // iOS zooms into a field with text under 16px.
    for (const size of await page.locator('textarea, input:not([type=checkbox]), select').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)))) {
      expect(size).toBeGreaterThanOrEqual(16);
    }
    // The queue sits below the card, and the button above the card takes you there.
    const jump = page.getByRole('button', { name: /waiting · show the queue/ });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(page.locator('.queue')).toBeInViewport();
  });

  test('the QR dialog fits the screen with its buttons in reach', async ({ page }) => {
    await inbox.open(page);
    await page.getByRole('button', { name: 'Open this inbox on your phone' }).click();
    expect(await readQr(page)).toMatch(new RegExp(`^${inbox.server.url}/#signin=[0-9a-f]{32}$`));
    const close = page.getByRole('button', { name: 'Close' });
    await expect(close).toBeInViewport();
    await close.click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test('the dialog says so when the QR code cannot load, and still shows the address', async ({ page }) => {
  await page.route('**/vendor/qrcode.mjs', (route) => route.fulfill({ status: 404, body: '' }));
  await inbox.open(page);
  await page.getByRole('button', { name: 'Open this inbox on your phone' }).click();
  await expect(page.locator('.qr-failed')).toContainText('did not load');
  await expect(page.locator('.qr-address')).toHaveCSS('font-family', /mono|Menlo|Courier|Code/i);
});

test('a phone that scans the code opens the inbox signed in, and the code works once', async ({ page, browser }) => {
  await inbox.agent.post({ id: 'scan-1', agent: 'scan', title: 'Seen on the phone after the scan', priority: 'now' });
  await inbox.open(page);
  await page.getByRole('button', { name: 'Open this inbox on your phone' }).click();
  const scanned = await readQr(page);
  const phone = await browser.newContext();
  const p = await phone.newPage();
  await p.goto(scanned!);
  await expect(p.getByText('Seen on the phone after the scan').first()).toBeVisible();
  expect(p.url()).not.toContain('signin=');
  const other = await browser.newContext();
  const q = await other.newPage();
  await q.goto(scanned!);
  await expect(q.getByRole('heading', { name: 'Sign in to your inbox' })).toBeVisible();
  await expect(q.locator('.signin')).toContainText('scan its QR code');
  await phone.close();
  await other.close();
});

test('Escape keeps an unused sign-in code in the address', async ({ page, browser }) => {
  await inbox.open(page);
  await page.getByRole('button', { name: 'Open this inbox on your phone' }).click();
  const scanned = await readQr(page);
  const phone = await browser.newContext();
  const p = await phone.newPage();
  // Hold the sign-in request, so the code is still unused when Escape comes.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await p.route('**/v1/login', async (route) => { await held; await route.continue(); });
  await p.goto(scanned!);
  await p.keyboard.press('Escape');
  expect(p.url()).toContain('signin=');
  release();
  await expect(p.getByRole('heading', { name: 'Sign in to your inbox' })).toBeHidden();
  await phone.close();
});

test('on a laptop inbox, the code opens the computer\'s network name, which the dialog shows', async ({ page }) => {
  await page.route('**/v1/addresses', (route) => route.fulfill({ json: { addresses: ['http://example-mac.local:4815', 'http://192.168.1.20:4815'] } }));
  await inbox.open(page);
  await page.getByRole('button', { name: 'Open this inbox on your phone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open this inbox on your phone' });
  expect(await readQr(page)).toMatch(/^http:\/\/example-mac\.local:4815\/#signin=[0-9a-f]{32}$/);
  await expect(dialog.locator('.qr-address')).toHaveText('http://example-mac.local:4815/');
  await expect(dialog).toContainText('192.168.1.20');
  await expect(dialog).not.toContainText('a phone cannot open it');
});

test('the sign-in page of a laptop inbox says to run your-attention open on that computer, and how to sign in another browser', async ({ browser }) => {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(`${inbox.server.url}/`);
  await expect(p.getByRole('heading', { name: 'Sign in to your inbox' })).toBeVisible();
  const steps = p.locator('.signin');
  await expect(steps).toContainText('This inbox runs on a computer.');
  await expect(steps.locator('ol li').nth(1)).toContainText('your-attention open --link');
  await expect(steps).toContainText('your-attention open --link');
  await expect(steps).toContainText('phone button');
  await context.close();
});

test('the dialog fits a full IPv6 address on one line, and never scrolls sideways', async ({ page }) => {
  const v6 = 'http://[2607:fa49:d342:a100:1c3e:5d2f:9b4a:7e11]:4815';
  await page.route('**/v1/addresses', (route) => route.fulfill({ json: { addresses: ['http://example-mac.local:4815', v6, 'http://192.168.1.20:4815'] } }));
  await inbox.open(page);
  await page.getByRole('button', { name: 'Open this inbox on your phone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open this inbox on your phone' });
  const code = dialog.locator('code', { hasText: '2607:fa49' });
  await expect(code).toBeVisible();
  const box = (await code.boundingBox())!;
  const line = await code.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.6);
  expect(box.height).toBeLessThan(line * 1.5);
  const scrolls = () => dialog.evaluate((el) => el.scrollWidth > el.clientWidth || [...el.querySelectorAll('*')].some((c) => c.scrollWidth > c.clientWidth + 1));
  expect(await scrolls()).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await scrolls()).toBe(false);
});
