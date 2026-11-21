// Focus mode: the open card fills the screen, with nothing else drawn but the button that leaves it, from one card to the
// next until the person leaves it, and the page comes back as the person left it.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
// Each test gets its own inbox, so the cards one test leaves open never decide the next card in another.
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

/** Browser notifications the test can read, turned on as the person turns them on. */
async function readNotifications(page: Page) {
  await page.addInitScript(() => {
    const notes: { title: string; body?: string }[] = [];
    (window as unknown as { yaNotes: typeof notes }).yaNotes = notes;
    class Note {
      static permission = 'granted';
      constructor(title: string, options?: { body?: string }) { notes.push({ title, ...(options?.body === undefined ? {} : { body: options.body }) }); }
    }
    Object.defineProperty(window, 'Notification', { value: Note });
    localStorage.setItem('notify:on', 'true');
  });
  return () => page.evaluate(() => (window as unknown as { yaNotes: { title: string; body?: string }[] }).yaNotes);
}

const post = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  inbox.agent.post({ id, agent: `s-${id}`, title, priority: 'soon', options: [{ id: 'o1', label: 'Yes' }], ...extra });
const dense = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the dense card, with enough words to wrap across the column.`).join('\n\n');
const toggle = (page: Page) => page.locator('.focus-card .focus-toggle');
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const pageY = (page: Page) => page.evaluate(() => window.scrollY);
const queueY = (page: Page) => page.locator('.queue').evaluate((el) => el.scrollTop);
/** The width of 1ch in the card's text, in pixels. */
const chWidth = (page: Page) => page.locator('.focus-card .card-text').first().evaluate((el) => {
  const probe = el.appendChild(document.createElement('div'));
  probe.style.width = '100ch';
  const width = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return width;
});

/** Open the card with this title from the queue, and turn focus mode on with the shortcut. */
async function focusOn(page: Page, title: string) {
  await page.locator('.q', { hasText: title }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText(title);
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
}

/** Only the open card shows: no bar, no queue, no border to resize it, and the card spans the viewport. */
async function expectFullScreen(page: Page) {
  await expect(page.locator('.bar')).toBeHidden();
  await expect(page.locator('.queue')).toBeHidden();
  await expect(page.locator('.resizer')).toBeHidden();
  await expect(page.locator('.to-queue')).toBeHidden();
  const width = page.viewportSize()!.width;
  const card = await box(page, '.focus-card');
  expect(card.x).toBe(0);
  expect(card.width).toBe(width);
}

test('focus mode fills the screen with the card, counts arrivals without a notification, and gives the page back as the person left it', async ({ page }) => {
  const notes = await readNotifications(page);
  await post('fm-dense', 'A dense card to read', { text: dense });
  for (let i = 1; i <= 24; i++) await post(`fm-fill-${i}`, `A card that waits, number ${i}`);
  await post('fm-gone', 'A card its agent will retract');
  await post('fm-sent', 'A card already answered');
  await inbox.agent.close('fm-sent', 'resolved', 'Done.');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A dense card to read' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('A dense card to read');
  // The person collapses Sent, scrolls the queue and the page, then turns focus on.
  const sentFold = page.locator('.queue h3.sent .fold', { hasText: 'Sent' });
  await sentFold.click();
  await expect(sentFold).toHaveAttribute('aria-expanded', 'false');
  await page.locator('.queue').evaluate((el) => { el.scrollTop = 150; });
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => pageY(page)).toBe(400);
  const before = { page: await pageY(page), queue: await queueY(page) };
  expect(before.queue).toBe(150);

  // The shortcut, since a click on the button would first scroll the page up to it.
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expectFullScreen(page);
  // The content sits in a column at the center, 108ch wide, and paragraphs keep a 72ch line.
  const width = page.viewportSize()!.width;
  const title = await box(page, '.focus-card .card-title');
  const ch = await chWidth(page);
  expect(title.width).toBeCloseTo(108 * ch, 0);
  expect(Math.abs(title.x - (width - title.x - title.width))).toBeLessThan(2);
  const paragraph = await box(page, '.focus-card .card-text p');
  expect(paragraph.width).toBeCloseTo(72 * ch, 0);
  expect(paragraph.x).toBeCloseTo(title.x, 0);
  // The button sits at the card's top right, and stays on screen at the end of the card.
  const corner = await box(page, '.focus-card .focus-toggle');
  expect(width - corner.x - corner.width).toBeLessThan(24);
  // The page scrolls the card, so scrolling to the end takes the card's title off screen, and the button stays.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => pageY(page)).toBeGreaterThan(500);
  await expect(page.locator('.focus-card .card-title')).not.toBeInViewport();
  await expect(toggle(page)).toBeInViewport();

  // A card that ranks above every other, a plain one, a revision of a card in the queue, a retraction, and a revision of the open card.
  await post('fm-urgent', 'An urgent card arrives', { priority: 'now' });
  await post('fm-plain', 'A plain card arrives');
  await post('fm-fill-1', 'A card that waits, number 1, revised');
  await inbox.agent.close('fm-gone', 'retracted', 'Not needed.');
  await post('fm-dense', 'A dense card to read', { text: `${dense}\n\nA paragraph the agent added at the end.` });

  await expect(page.locator('.focus-card')).toContainText('A paragraph the agent added at the end.');
  await expect(page.locator('.focus-card .focus-count')).toHaveText('2');
  await expect(toggle(page)).toHaveAccessibleName('Leave focus mode, 2 new cards waiting');
  await expectFullScreen(page);
  expect(await notes()).toEqual([]);

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.bar')).toBeVisible();
  await expect(page.locator('.queue')).toBeVisible();
  await expect.poll(() => pageY(page)).toBe(before.page);
  await expect.poll(() => queueY(page)).toBe(before.queue);
  await expect(sentFold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.queue .q').first()).toContainText('An urgent card arrives');
  await expect(page.locator('.queue .q', { hasText: 'A plain card arrives' })).toContainText('new');
  await expect(page.locator('.queue .q', { hasText: 'A card that waits, number 1, revised' })).toHaveCount(1);
  await expect(page.locator('.focus-card .card-title')).toHaveText('A dense card to read');
  expect(await notes()).toEqual([{ title: '2 cards arrived while you focused', body: 'An urgent card arrives · A plain card arrives' }]);
});

test('focus mode lasts through a reload, in this tab only, and Escape ends it with the card still open', async ({ page, context }) => {
  await post('fm-keep', 'A card read across a reload');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A card read across a reload' }).click();
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card read across a reload');
  await expectFullScreen(page);
  await post('fm-late', 'A card that arrives after the reload');
  await expect(page.locator('.focus-card .focus-count')).toHaveText('1');

  // Another tab of the same browser has focus mode off, and shows the new card.
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.locator('.queue .q', { hasText: 'A card that arrives after the reload' })).toBeVisible();
  await expect(other.locator('.focus-card .focus-toggle')).toHaveAttribute('aria-pressed', 'false');
  await other.close();

  await page.locator('.focus-card .card-title').click();
  await page.keyboard.press('Escape');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card read across a reload');
  await expect(page.locator('.queue .q', { hasText: 'A card that arrives after the reload' })).toBeVisible();
});

test('answering in focus keeps focus mode on and opens the next card of the queue as it is now, full screen', async ({ page }) => {
  const notes = await readNotifications(page);
  await post('fm-answer', 'A card to answer in focus', { priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A card to answer in focus' }).click();
  await page.getByRole('button', { name: 'Turn on focus mode' }).click();
  await post('fm-next', 'The next card, posted during focus', { priority: 'now' });
  await post('fm-later', 'A card that waits behind it', { priority: 'soon' });
  await expect(page.locator('.focus-card .focus-count')).toHaveText('2');
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The next card, posted during focus');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expectFullScreen(page);
  // The card on screen is no longer news, so the count and the notification at the end name only the other one.
  await expect(page.locator('.focus-card .focus-count')).toHaveText('1');
  await expect(toggle(page)).toHaveAccessibleName('Leave focus mode, 1 new card waiting');
  expect(await notes()).toEqual([]);
  await toggle(page).click();
  await expect(page.locator('.queue')).toBeVisible();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The next card, posted during focus');
  expect(await notes()).toEqual([{ title: 'A card arrived while you focused', body: 'A card that waits behind it' }]);
});

test('Skip for now in focus keeps focus mode on and opens the next card, scrolled to its top', async ({ page }) => {
  await post('fm-skip-1', 'The first card to skip', { priority: 'now', text: dense });
  await post('fm-skip-2', 'The second card', { priority: 'soon' });
  await inbox.open(page);
  await focusOn(page, 'The first card to skip');
  await page.locator('.focus-card button', { hasText: 'Skip for now' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The second card');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expectFullScreen(page);
  await expect.poll(() => pageY(page)).toBe(0);
  // Skip wraps around the queue, as it does outside focus mode.
  await page.locator('.focus-card button', { hasText: 'Skip for now' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The first card to skip');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
});

test('Dismiss in focus keeps focus mode on and opens the next card', async ({ page }) => {
  await post('fm-dismiss-1', 'A card to dismiss in focus', { priority: 'now' });
  await post('fm-dismiss-2', 'The card after the dismissed one', { priority: 'soon' });
  await inbox.open(page);
  await focusOn(page, 'A card to dismiss in focus');
  await page.locator('.focus-card .openui-buttons').getByRole('button', { name: 'Dismiss without telling the agent' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The card after the dismissed one');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expectFullScreen(page);
});

test('a link to another card, and the back button, keep focus mode on', async ({ page }) => {
  await post('fm-target', 'The card the link opens', { priority: 'soon' });
  await post('fm-linking', 'A card that links to another', { priority: 'now', text: 'See [[fm-target]].' });
  await inbox.open(page);
  await focusOn(page, 'A card that links to another');
  await page.locator('.focus-card .card-text a', { hasText: 'The card the link opens' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The card the link opens');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expectFullScreen(page);
  await page.goBack();
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card that links to another');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expectFullScreen(page);
});

test('when no card is left, focus mode shows that nothing needs you, full screen, and the next card that arrives opens there', async ({ page }) => {
  const notes = await readNotifications(page);
  await post('fm-last', 'The last card', { priority: 'now' });
  await inbox.open(page);
  await expect(page.locator('.focus-card .card-title')).toHaveText('The last card');
  await page.keyboard.press('ControlOrMeta+.');
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await expect(page.locator('.focus-card.done')).toContainText('Nothing needs you');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page)).toBeInViewport();
  await expectFullScreen(page);

  await post('fm-arrives', 'A card that arrives on the empty screen', { priority: 'soon' });
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card that arrives on the empty screen');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.focus-card .focus-count')).toHaveCount(0);
  await expectFullScreen(page);
  await toggle(page).click();
  await expect(page.locator('.queue')).toBeVisible();
  // The person saw the card that arrived, so leaving raises no notification for it.
  expect(await notes()).toEqual([]);
});

test('on a phone, focus mode fills the screen too, and leaving it scrolls back to where the person was', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await post('fm-phone', 'A card read on a phone', { text: dense, priority: 'now' });
  // The only card opens by itself. A click on it would scroll the page to the card, after the scroll below.
  await inbox.open(page);
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card read on a phone');
  await expect(page.locator('.to-queue')).toHaveText('1 waiting · show the queue');
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect.poll(() => pageY(page)).toBe(600);
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expectFullScreen(page);
  await expect(toggle(page)).toBeInViewport();
  await post('fm-phone-new', 'A card that arrives on the phone', { priority: 'now' });
  await expect(page.locator('.focus-card .focus-count')).toHaveText('1');
  await toggle(page).click();
  await expect(page.locator('.to-queue')).toHaveText('2 waiting · show the queue');
  await expect.poll(() => pageY(page)).toBe(600);
});

const WIDE = `A paragraph above the table, long enough to wrap: ${'the column gives tables room while prose keeps the line length that reads well, '.repeat(4)}\n\n`
  + `| ${Array.from({ length: 8 }, (_, i) => `Column ${i + 1}`).join(' | ')} |\n|${' --- |'.repeat(8)}\n`
  + `| ${Array.from({ length: 8 }, (_, i) => `value-${i + 1}-with-a-long-name`).join(' | ')} |`;

test('the focus column is half again as wide as a paragraph, so a wide table gets the room and the text keeps its line length', async ({ page }) => {
  await post('fm-wide', 'A card with a wide table', { text: WIDE, priority: 'now' });
  await inbox.open(page);
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card with a wide table');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  const ch = await chWidth(page);
  const title = await box(page, '.focus-card .card-title');
  const table = await box(page, '.focus-card .card-text table');
  const paragraph = await box(page, '.focus-card .card-text p');
  expect(title.width).toBeCloseTo(108 * ch, 0);
  expect(table.width).toBeGreaterThan(72 * ch + 10);
  expect(table.width).toBeLessThanOrEqual(title.width + 1);
  expect(paragraph.width).toBeCloseTo(72 * ch, 0);

  // On a phone the column is the screen less its 16px gutters.
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await box(page, '.focus-card .card-title');
  expect(narrow.x).toBeCloseTo(16, 0);
  expect(narrow.width).toBeCloseTo(390 - 32, 0);
  expect((await box(page, '.focus-card .card-text p')).width).toBeCloseTo(390 - 32, 0);
});

test('in focus mode, your answer to the card before this one keeps the 72ch line of the text around it', async ({ page }) => {
  const comment = 'A long comment on the first card, which the panel of the card before this one repeats in full. '.repeat(4).trim();
  await post('fm-before', 'The card before', { priority: 'now' });
  await inbox.open(page);
  await expect(page.locator('.focus-card .card-title')).toHaveText('The card before');
  await page.locator('.focus-card').getByPlaceholder('Anything to add?').fill(comment);
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await post('fm-after', 'The card after', { priority: 'now', follows: 'fm-before', text: 'A follow-up to your answer.' });
  await page.locator('.q', { hasText: 'The card after' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The card after');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.focus-card details.earlier summary').click();
  const answer = page.locator('.focus-card details.earlier .ans');
  await expect(answer).toContainText('A long comment on the first card');
  const ch = await chWidth(page);
  expect((await answer.boundingBox())!.width).toBeLessThanOrEqual(72 * ch + 1);
});

test('in focus mode, a list inside a list item takes no cap of its own, since the list around it already has one', async ({ page }) => {
  await post('fm-nested', 'A card with a nested list', { priority: 'now', text: '- The outer item\n  - The inner item' });
  await inbox.open(page);
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card with a nested list');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  // The cap reads as a fraction of a pixel that differs between font builds, so it compares as a number.
  const cap = await page.locator('.focus-card .card-text > ul').evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
  expect(cap).toBeCloseTo(72 * await chWidth(page), 0);
  await expect(page.locator('.focus-card .card-text li ul')).toHaveCSS('max-width', 'none');
});

test('in focus mode, the closing note and the unsent draft of a closed card keep the 72ch line of the text around them', async ({ page }) => {
  const long = (what: string) => `${what}, long enough to run past a 72ch line when the column gives it room to. `.repeat(3).trim();
  await post('fm-draft', 'A card to dismiss with a draft', { priority: 'now', text: 'A card the person dismisses.' });
  await inbox.open(page);
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card to dismiss with a draft');
  await page.locator('.focus-card').getByPlaceholder('Anything to add?').fill(long('A draft the person typed'));
  await page.locator('.focus-card .openui-buttons').getByRole('button', { name: 'Dismiss without telling the agent' }).click();
  await page.locator('nav.queue .q.dim', { hasText: 'A card to dismiss with a draft' }).click();
  await expect(page.locator('.dismiss-draft')).toContainText('A draft the person typed');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  const ch = await chWidth(page);
  expect((await box(page, '.dismiss-draft-body')).width).toBeLessThanOrEqual(72 * ch + 1);
  await page.keyboard.press('ControlOrMeta+.');

  await post('fm-note', 'A card its agent closes', { priority: 'now', text: 'A card the agent closes.' });
  await page.locator('.q', { hasText: 'A card its agent closes' }).click();
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await inbox.agent.close('fm-note', 'resolved', long('A closing note from the agent'));
  await expect(page.locator('.closed-line .o')).toContainText('A closing note from the agent');
  expect((await box(page, '.closed-line .o')).width).toBeLessThanOrEqual(72 * ch + 1);
});

test('in focus mode, an agent reply keeps the 72ch line, since its text reads as paragraphs', async ({ page }) => {
  const reply = 'A reply from the agent, long enough to run past a 72ch line when the column gives it room to. '.repeat(3).trim();
  await post('fm-reply', 'A card with a reply', { priority: 'now', text: 'A card the agent replied to.' });
  inbox.seedReplies('fm-reply', [reply]);
  await inbox.open(page);
  await expect(page.locator('.reply-msg')).toContainText('A reply from the agent');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  const ch = await chWidth(page);
  expect((await box(page, '.reply-msg p')).width).toBeLessThanOrEqual(72 * ch + 1);
});

test('in focus mode, a note and the lines of a revision\'s changes keep the 72ch line, since they are plain text', async ({ page }) => {
  const long = (what: string) => `${what}, long enough to run past a 72ch line when the column gives it room to. `.repeat(3).trim();
  await post('fm-changes', 'A card the agent revised', { priority: 'now', text: 'The plan uses SQLite.' });
  await inbox.agent.patch('fm-changes', [{ old: 'SQLite', new: long('SQLite with FTS5') }]);
  await post('fm-noted', 'A card you answered', { priority: 'soon', text: 'A card the person answers.' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A card you answered' }).click();
  await page.locator('.focus-card').getByPlaceholder('Anything to add?').fill(long('A comment on the answer'));
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await page.locator('nav.queue .q', { hasText: 'A card you answered' }).click();
  await expect(page.locator('.note.ok')).toContainText('A comment on the answer');
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  const ch = await chWidth(page);
  expect((await box(page, '.note.ok')).width).toBeLessThanOrEqual(72 * ch + 1);
  await page.keyboard.press('ControlOrMeta+.');

  await page.locator('nav.queue .q', { hasText: 'A card the agent revised' }).click();
  await page.keyboard.press('ControlOrMeta+.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('details.changes summary').click();
  await expect(page.locator('details.changes .add')).toContainText('SQLite with FTS5');
  expect((await box(page, 'details.changes .add')).width).toBeLessThanOrEqual(72 * ch + 1);
});
