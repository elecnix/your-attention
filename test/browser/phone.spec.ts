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

test('the phone button shows a QR code of the inbox address, without the sign-in token', async ({ page }) => {
  await inbox.open(page);
  const phone = page.getByRole('button', { name: 'Open this inbox on your phone' });
  const repo = page.getByRole('link', { name: 'Your Attention on GitHub' });
  // The phone button sits just left of the GitHub mark.
  const [p, r] = [await phone.boundingBox(), await repo.boundingBox()];
  expect(p!.x + p!.width).toBeLessThanOrEqual(r!.x);
  await phone.click();
  const dialog = page.getByRole('dialog', { name: 'Open this inbox on your phone' });
  await expect(dialog).toBeVisible();
  expect(await readQr(page)).toBe(`${inbox.server.url}/`);
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
    expect(await readQr(page)).toBe(`${inbox.server.url}/`);
    const close = page.getByRole('button', { name: 'Close' });
    await expect(close).toBeInViewport();
    await close.click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});
