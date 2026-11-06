// Collapsed groups in the left queue: the heading stays put with its count while its cards hide, a card that
// arrives in a muted group stays out of sight and out of Skip for now, a link still opens it, and the choice
// stays on this device across a reload and a Group by round trip.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

const headings = (page: Page) => page.locator('.queue h3').allInnerTexts();
const heading = (page: Page, name: string) => page.locator('.queue h3', { hasText: name });
/** The button on a group heading that opens and collapses the group. */
const fold = (page: Page, name: string) => heading(page, name).locator('button.fold');
const card = (page: Page, title: string) => page.locator('.queue .q', { hasText: title });
const groupBy = (page: Page, value: string) => page.locator('.group-by select').selectOption(value);
const post = (id: string, title: string, priority: string, topic: string, text?: string) =>
  inbox.agent.post({ id, agent: 's-collapse', title, priority, ...(text === undefined ? {} : { text }), tags: { topic } });

test('a collapsed group hides a card that arrives, raises its count, and keeps its place', async ({ page }) => {
  await post('cg-b1', 'First billing card', 'soon', 'billing');
  await post('cg-s1', 'First search card', 'soon', 'search');
  await inbox.open(page);
  await groupBy(page, 'tag:topic');

  const billing = fold(page, 'billing');
  await expect(billing).toHaveAttribute('aria-expanded', 'true');
  await billing.click();
  await expect(billing).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, 'First billing card')).toHaveCount(0);
  await expect(heading(page, 'billing')).toContainText(/billing \(1\)/i);

  // A card that arrives in the muted group stays hidden, and the count goes up.
  await post('cg-b2', 'Second billing card', 'soon', 'billing');
  await expect(heading(page, 'billing')).toContainText(/billing \(2\)/i);
  await expect(card(page, 'Second billing card')).toHaveCount(0);
  // The heading keeps its place at the top of the queue.
  expect((await headings(page))[0]?.toLowerCase()).toContain('billing');

  // Opening the group brings its cards back, and the keyboard reaches the same button.
  await billing.click();
  await expect(card(page, 'First billing card')).toBeVisible();
  await expect(card(page, 'Second billing card')).toBeVisible();
  await billing.focus();
  await page.keyboard.press('Enter');
  await expect(billing).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, 'First billing card')).toHaveCount(0);
});

test('the triangle turns between its two positions, and reduce motion turns the animation off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await post('cg5-b1', 'Billing card', 'soon', 'billing');
  await inbox.open(page);
  await groupBy(page, 'tag:topic');
  const billing = fold(page, 'billing');
  const tri = billing.locator('.fold-tri');
  expect(await tri.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  const open = await tri.evaluate((el) => getComputedStyle(el).transform);
  await billing.click();
  const shut = await tri.evaluate((el) => getComputedStyle(el).transform);
  expect(open).not.toBe(shut);
});

test('Skip for now passes over a collapsed group, and a link still opens its card', async ({ page }) => {
  await post('cg2-b1', 'First billing card', 'now', 'billing');
  await post('cg2-b2', 'Second billing card', 'now', 'billing');
  await post('cg2-s1', 'Search card', 'now', 'search', 'Details in [[cg2-b2]].');
  await inbox.open(page);
  await groupBy(page, 'tag:topic');

  await card(page, 'First billing card').click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('First billing card');
  await fold(page, 'billing').click();
  // The card on screen stays on screen, as a new card never replaces it.
  await expect(page.locator('.focus-card .card-title')).toHaveText('First billing card');
  await page.locator('.focus-card button', { hasText: 'Skip for now' }).click();
  // Skip passes over the two hidden billing cards.
  await expect(page.locator('.focus-card .card-title')).toHaveText('Search card');

  // A card the person opens by a link still opens, even in a collapsed group.
  await page.locator('.focus-card .card-link', { hasText: 'Second billing card' }).click();
  await expect(page.locator('.focus-card .card-title')).toHaveText('Second billing card');
});

test('a card at the highest level notifies inside a collapsed group, and a lower one does not', async ({ page }) => {
  // A browser notification the test can read, turned on as the person turns it on.
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
  const notes = () => page.evaluate(() => (window as unknown as { yaNotes: { body?: string }[] }).yaNotes.map((n) => n.body));
  await post('cg3-b1', 'First billing card', 'soon', 'billing');
  await post('cg3-s1', 'First search card', 'soon', 'search');
  await inbox.open(page);
  await groupBy(page, 'tag:topic');
  await fold(page, 'billing').click();

  // A lower-level card that arrives in the muted group stays quiet.
  await post('cg3-b2', 'Second billing card', 'soon', 'billing');
  await expect(heading(page, 'billing')).toContainText(/billing \(2\)/i);
  await page.waitForTimeout(500);
  expect(await notes()).toEqual([]);

  // Decide now is the exception: muting a group cannot hide an urgent card.
  await post('cg3-b3', 'Urgent billing card', 'now', 'billing');
  await expect.poll(notes).toContain('Urgent billing card');
  // A card in a group that is open notifies as before.
  await post('cg3-s2', 'Second search card', 'soon', 'search');
  await expect.poll(notes).toContain('Second search card');
});

test('a collapsed group stays collapsed across a reload and a Group by round trip', async ({ page }) => {
  await post('cg4-b1', 'Billing card', 'soon', 'billing');
  await post('cg4-s1', 'Search card', 'soon', 'search');
  await inbox.open(page);
  await groupBy(page, 'tag:topic');
  await fold(page, 'billing').click();
  await expect(card(page, 'Billing card')).toHaveCount(0);
  // The choice stays on this device, next to Group by and the pins.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('collapsedGroups') || '[]'))).toEqual(['topic: billing']);

  await page.reload();
  await page.locator('.bar .pill.on').waitFor();
  await expect(fold(page, 'billing')).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, 'Billing card')).toHaveCount(0);
  await expect(card(page, 'Search card')).toBeVisible();

  // Another Group by choice has its own collapsed groups, and coming back restores this one.
  await groupBy(page, 'none');
  await expect(card(page, 'Billing card')).toBeVisible();
  await groupBy(page, 'tag:topic');
  await expect(fold(page, 'billing')).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, 'Billing card')).toHaveCount(0);
});
