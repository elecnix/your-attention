// A click on a diagram opens it full screen, in normal mode and in focus mode, and a click, Escape or the back button
// gives the card back where the person left it.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

const FLOW = 'flowchart LR\n  Post --> Check --> Show\n  Check -- refused --> Agent';
const lead = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1}, which pushes the diagram below the fold so the page has to scroll to it.`).join('\n\n');
const TEXT = `${lead}\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\nThe end of the card.`;

const opener = (page: Page) => page.locator('.focus-card .diagram-open');
const overlay = (page: Page) => page.locator('dialog.diagram-zoom');
const pageY = (page: Page) => page.evaluate(() => window.scrollY);
const toggle = (page: Page) => page.locator('.focus-card .focus-toggle');

async function openCard(page: Page, id: string, title: string, text = TEXT) {
  await inbox.agent.post({ id, agent: `s-${id}`, title, text, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: title }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText(title);
  await expect(opener(page).locator('svg')).toHaveCount(1);
}

/** Opens the diagram, and checks the overlay covers the viewport and shows the diagram as large as it fits. */
async function zoomIn(page: Page) {
  await opener(page).click();
  await expect(overlay(page)).toBeVisible();
  const view = page.viewportSize()!;
  const box = (await overlay(page).boundingBox())!;
  expect(box).toEqual({ x: 0, y: 0, width: view.width, height: view.height });
  // A wide flowchart meets the sides of the screen, less the gutters, and keeps its shape.
  const svg = (await overlay(page).locator('.diagram-zoomed > svg').boundingBox())!;
  const card = (await opener(page).locator('svg').boundingBox())!;
  expect(svg.width).toBeGreaterThan(card.width * 1.2);
  expect(svg.width).toBeLessThanOrEqual(view.width - 32 + 1);
  expect(Math.max(view.width - 32 - svg.width, view.height - 32 - svg.height)).toBeGreaterThanOrEqual(-1);
  expect(Math.min(view.width - 32 - svg.width, view.height - 32 - svg.height)).toBeLessThan(2);
  expect(svg.width / svg.height).toBeCloseTo(card.width / card.height, 1);
  await expect(overlay(page).locator('.diagram-zoomed > svg')).toContainText('Check');
  // Focus moves into the overlay, on its close button.
  await expect(page.getByRole('button', { name: 'Close the full-screen diagram' })).toBeFocused();
}

async function expectBack(page: Page, y: number) {
  await expect(overlay(page)).toBeHidden();
  await expect.poll(() => pageY(page)).toBe(y);
  await expect(opener(page)).toBeFocused();
}

test('a diagram on a card opens full screen, and a click, Escape or the back button gives the card back at the same place', async ({ page }) => {
  await openCard(page, 'zoom-normal', 'A diagram to zoom');
  await expect(opener(page)).toHaveAccessibleName('Open the diagram full screen');
  await opener(page).scrollIntoViewIfNeeded();
  const y = await pageY(page);
  expect(y).toBeGreaterThan(200);
  const address = page.url();

  await zoomIn(page);
  await page.mouse.click(10, 10);
  await expectBack(page, y);
  expect(page.url()).toBe(address);

  // A tap on the diagram itself closes it too.
  await zoomIn(page);
  await overlay(page).locator('.diagram-zoomed > svg').click();
  await expectBack(page, y);

  // Escape closes the overlay alone: the card stays open.
  await zoomIn(page);
  await page.keyboard.press('Escape');
  await expectBack(page, y);
  await expect(page.locator('.focus-card .card-title')).toHaveText('A diagram to zoom');

  // The back button closes the overlay and stays on the card.
  await zoomIn(page);
  await page.goBack();
  await expectBack(page, y);
  expect(page.url()).toBe(address);
  await expect(page.locator('.focus-card .card-title')).toHaveText('A diagram to zoom');
});

test('in focus mode a diagram opens full screen, and Escape closes it and leaves focus mode on', async ({ page }) => {
  await openCard(page, 'zoom-focus', 'A diagram to zoom in focus mode');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await opener(page).scrollIntoViewIfNeeded();
  const y = await pageY(page);
  expect(y).toBeGreaterThan(200);

  await zoomIn(page);
  await page.keyboard.press('Escape');
  await expectBack(page, y);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

  await zoomIn(page);
  await page.mouse.click(page.viewportSize()!.width - 10, page.viewportSize()!.height - 10);
  await expectBack(page, y);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the full-screen diagram sits on the page background in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openCard(page, `zoom-${scheme}`, `A diagram in the ${scheme} theme`, `\`\`\`mermaid\n${FLOW}\n\`\`\``);
    await zoomIn(page);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect(overlay(page)).toHaveCSS('background-color', bg);
    // Nodes keep the page's info colors: --info-bg is #e3eafb in light and #1c2645 in dark.
    await expect(overlay(page).locator('.diagram-zoomed svg .node rect').first()).toHaveCSS('fill', scheme === 'light' ? 'rgb(227, 234, 251)' : 'rgb(28, 38, 69)');
  });
}

test('a diagram larger than a phone screen opens at its own size, and the overlay scrolls it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const steps = Array.from({ length: 30 }, (_, i) => `  S${i} --> S${i + 1}`).join('\n');
  await openCard(page, 'zoom-tall', 'A tall diagram', `\`\`\`mermaid\nflowchart TD\n${steps}\n\`\`\``);
  await opener(page).click();
  await expect(overlay(page)).toBeVisible();
  const scroll = await overlay(page).evaluate((el) => ({ height: el.scrollHeight, view: el.clientHeight }));
  expect(scroll.height).toBeGreaterThan(scroll.view);
  await page.keyboard.press('Escape');
  await expect(overlay(page)).toBeHidden();
});

test('a wide flowchart on a phone opens at its own size, larger than on the card, and the overlay scrolls it sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const steps = Array.from({ length: 8 }, (_, i) => `  S${i}["Step ${i} of the flow"] --> S${i + 1}`).join('\n');
  await openCard(page, 'zoom-wide', 'A wide diagram', `\`\`\`mermaid\nflowchart LR\n${steps}\n\`\`\``);
  const card = (await opener(page).locator('svg').boundingBox())!;
  await opener(page).click();
  await expect(overlay(page)).toBeVisible();
  const zoomed = overlay(page).locator('.diagram-zoomed > svg');
  const natural = await zoomed.evaluate((el) => (el as SVGSVGElement).viewBox.baseVal.width);
  expect((await zoomed.boundingBox())!.width).toBeCloseTo(natural, 0);
  expect(natural).toBeGreaterThan(card.width * 2);
  const scroll = await overlay(page).evaluate((el) => ({ width: el.scrollWidth, view: el.clientWidth }));
  expect(scroll.width).toBeGreaterThan(scroll.view);
  await page.mouse.click(10, 400);
  await expect(overlay(page)).toBeHidden();
});

test('a diagram that did not draw shows its source and does not open', async ({ page }) => {
  await page.route('**/vendor/mermaid.min.js*', (r) => r.abort());
  await inbox.agent.post({ id: 'zoom-fail', agent: 's-zoom-fail', title: 'A diagram that fails', text: `\`\`\`mermaid\n${FLOW}\n\`\`\``, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A diagram that fails' }).click();
  await expect(page.locator('.card-text pre.diagram-source')).toContainText('Post --> Check');
  await expect(opener(page)).toHaveCount(0);
  await page.locator('.card-text pre.diagram-source').click();
  await expect(overlay(page)).toHaveCount(0);
});
