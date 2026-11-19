// Focus mode: the open card stays put while cards arrive, change and close, and the queue catches up when focus ends.
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
const queueTitles = (page: Page) => page.locator('.queue .q .t-title').allTextContents();
const toggle = (page: Page) => page.locator('.focus-card .focus-toggle');

test('focus mode holds arrivals, changes and notifications, shows a revision of the open card in place, and catches up on leaving', async ({ page }) => {
  const notes = await readNotifications(page);
  await post('fm-dense', 'A dense card to read', { text: dense });
  await post('fm-other', 'Another card that waits');
  await post('fm-gone', 'A card its agent will retract');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A dense card to read' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('A dense card to read');
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Focus on this card' }).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  const before = { queue: await queueTitles(page), y: await page.evaluate(() => window.scrollY), top: (await page.locator('.focus-card .card-title').boundingBox())!.y, icon: await page.locator('link[rel="icon"]').getAttribute('href') };

  // A card that ranks above every other, a plain one, a revision of a card in the queue, a retraction, and a revision of the open card.
  await post('fm-urgent', 'An urgent card arrives', { priority: 'now' });
  await post('fm-plain', 'A plain card arrives');
  await post('fm-other', 'Another card that waits, revised');
  await inbox.agent.close('fm-gone', 'retracted', 'Not needed.');
  await post('fm-dense', 'A dense card to read', { text: `${dense}\n\nA paragraph the agent added at the end.` });

  await expect(page.locator('.focus-card')).toContainText('A paragraph the agent added at the end.');
  await expect(page.locator('.focus-card .focus-count')).toHaveText('2');
  await expect(toggle(page)).toHaveAccessibleName('Leave focus mode, 2 new cards waiting');
  expect(await queueTitles(page)).toEqual(before.queue);
  expect(await page.evaluate(() => window.scrollY)).toBe(before.y);
  expect((await page.locator('.focus-card .card-title').boundingBox())!.y).toBe(before.top);
  expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe(before.icon);
  expect(await notes()).toEqual([]);

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.queue .q', { hasText: 'An urgent card arrives' })).toBeVisible();
  await expect(page.locator('.queue .q', { hasText: 'A plain card arrives' })).toContainText('new');
  await expect(page.locator('.queue .q', { hasText: 'Another card that waits, revised' })).toBeVisible();
  await expect(page.locator('.queue .sent ~ .q.dim', { hasText: 'A card its agent will retract' })).toBeVisible();
  expect((await queueTitles(page))[0]).toBe('An urgent card arrives');
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
  await post('fm-late', 'A card that arrives after the reload');
  await expect(page.locator('.focus-card .focus-count')).toHaveText('1');
  await expect(page.locator('.queue .q', { hasText: 'A card that arrives after the reload' })).toHaveCount(0);

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

test('answering the card in focus ends focus mode and opens the next card of the queue as it is now', async ({ page }) => {
  await post('fm-answer', 'A card to answer in focus', { priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A card to answer in focus' }).click();
  await page.getByRole('button', { name: 'Focus on this card' }).click();
  await post('fm-next', 'The next card, posted during focus', { priority: 'now' });
  await expect(page.locator('.focus-card .focus-count')).toHaveText('1');
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('The next card, posted during focus');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('on a phone, the card stays put and the count above it holds while focus is on', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await post('fm-phone', 'A card read on a phone', { text: dense, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A card read on a phone' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('A card read on a phone');
  await page.getByRole('button', { name: 'Focus on this card' }).click();
  const count = await page.locator('.to-queue').textContent();
  const top = (await page.locator('.focus-card .card-title').boundingBox())!.y;
  await post('fm-phone-new', 'A card that arrives on the phone', { priority: 'now' });
  await expect(page.locator('.focus-card .focus-count')).toHaveText('1');
  expect(await page.locator('.to-queue').textContent()).toBe(count);
  expect((await page.locator('.focus-card .card-title').boundingBox())!.y).toBe(top);
  await toggle(page).click();
  await expect(page.locator('.to-queue')).not.toHaveText(count!);
});

test('a Group by choice made during focus mode stays when the next card arrives', async ({ page }) => {
  await post('fm-group', 'A card read while regrouping');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A card read while regrouping' }).click();
  await page.getByRole('button', { name: 'Focus on this card' }).click();
  const select = page.locator('.group-by select');
  await select.selectOption('priority');
  await expect.poll(async () => (await inbox.state() as unknown as { settings?: { groupBy?: string } }).settings?.groupBy).toBe('priority');
  await post('fm-group-new', 'A card that arrives after the regrouping');
  await expect(page.locator('.focus-card .focus-count')).toHaveText('1');
  await expect(select).toHaveValue('priority');
});
