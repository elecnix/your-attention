// A card its agent takes back while the person types: the closed card keeps what the person typed, with a button that
// sends it to the agent anyway, as a late answer, and one that discards it. Re-expanding the card shows all of it.
import { expect, test, type Page } from '@playwright/test';
import type { Answer, Card } from '../../src/core/types.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

const cardDetail = async (id: string): Promise<{ card: Card; answer?: Answer }> => {
  const res = await fetch(`${inbox.server.url}/v1/cards/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } });
  return (await res.json()) as { card: Card; answer?: Answer };
};
const post = (id: string, agent: string, extra: Record<string, unknown> = {}) =>
  inbox.agent.post({ id, agent, title: 'Which size?', text: 'Pick the size that fits.', priority: 'now', options: [{ id: 'o1', label: 'Small' }, { id: 'o2', label: 'Large' }], ...extra });
const draft = (page: Page) => page.locator('.late-draft');

/** Open the card, pick Large and type a comment, then have its agent take it back. */
async function typeThenClose(page: Page, id: string, agent: string) {
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Which size?' }).click();
  await page.getByText('Large', { exact: true }).click();
  await page.locator('.focus-card textarea').last().fill('Large, the small one is sold out.');
  // The draft is in the device store before the agent closes the card.
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), `draft:${id}:1`)).toContain('sold out');
  await inbox.agent.close(id, 'retracted', 'Picked Small myself.');
  await expect(page.locator('.closed-line .tag')).toHaveText('Retracted by agent');
}

/** Whether the element ends inside the box that clips the closed card's body. */
const insideCollapse = (page: Page, selector: string) => page.locator(selector).evaluate((el) => {
  const box = el.closest('.collapse')!.getBoundingClientRect();
  return el.getBoundingClientRect().bottom <= box.bottom + 1;
});

test('Show card shows the whole card, Send answer included, after the card grew while it was collapsed', async ({ page }) => {
  await post('grew', 's-grew');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Which size?' }).click();
  await inbox.agent.close('grew', 'self-answered', 'Found it in the README.');
  await expect(page.locator('.collapse')).toHaveCSS('opacity', '0');
  // The agent revises the closed card with a much longer text, so the body is taller than when the page measured it.
  const long = Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1}, which makes the card taller than it was.`).join('\n\n');
  await post('grew', 's-grew', { text: long });
  await expect(page.locator('.collapse .card-text')).toContainText('Paragraph 25');
  await page.getByRole('button', { name: 'Show card' }).click();
  await expect(page.locator('.collapse')).toHaveCSS('opacity', '1');
  await expect.poll(() => insideCollapse(page, '.collapse .openui-buttons')).toBe(true);
  // The body grows again while it is open, and the box follows it.
  await page.setViewportSize({ width: 520, height: 800 });
  await expect.poll(() => insideCollapse(page, '.collapse .openui-buttons')).toBe(true);
  const send = page.locator('.collapse').getByRole('button', { name: 'Send answer' });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport();
});

test('a draft typed before the agent took the card back goes to the agent anyway, marked late', async ({ page }) => {
  await post('late', 's-late');
  const heard = inbox.listen('s-late');
  await typeThenClose(page, 'late', 's-late');
  // The closed card says what the person typed, and how to send it, without opening the card.
  await expect(draft(page)).toContainText('Large');
  await expect(draft(page)).toContainText('Large, the small one is sold out.');
  await expect(draft(page)).toContainText('The agent took this card back before you sent it.');
  // The pictures for the pull request: the closed card with the draft, in both color schemes. They stay in test-results.
  await expect(page.locator('.collapse')).toHaveCSS('opacity', '0');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator('.closed-line').locator('..').screenshot({ path: test.info().outputPath(`late-draft-${scheme}.png`) });
  }
  await page.getByRole('button', { name: 'Show card' }).click();
  await expect.poll(() => insideCollapse(page, '.collapse .openui-buttons')).toBe(true);
  await draft(page).getByRole('button', { name: 'Send to the agent anyway' }).click();
  await expect.poll(() => heard.events.filter((e) => e.type === 'answer').length).toBe(1);
  const ev = heard.events.find((e) => e.type === 'answer');
  if (ev?.type !== 'answer') throw new Error('no answer');
  expect(ev.answer.late).toMatchObject({ kind: 'retracted', outcome: 'Picked Small myself.' });
  expect(ev.answer.values['choice']).toBe('o2');
  expect(ev.answer.comment).toBe('Large, the small one is sold out.');
  const stored = await cardDetail('late');
  expect(stored.card.closed?.kind).toBe('retracted');
  // The card shows the answer and says it went after the agent closed the card. The draft is gone from the device.
  await expect(page.locator('.note.late')).toContainText('after the agent took the card back');
  await expect(draft(page)).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draft:late:')))).toEqual([]);
  await page.waitForTimeout(500);
  expect(heard.events.filter((e) => e.type === 'answer').length, 'delivered once').toBe(1);
});

test('Discard drops the draft, and the agent hears nothing', async ({ page }) => {
  await post('drop', 's-drop');
  const heard = inbox.listen('s-drop');
  await typeThenClose(page, 'drop', 's-drop');
  await draft(page).getByRole('button', { name: 'Discard' }).click();
  await expect(draft(page)).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draft:drop:')))).toEqual([]);
  await page.getByRole('button', { name: 'Show card' }).click();
  await expect(page.locator('.collapse textarea').last()).toHaveValue('');
  // After a reload the draft stays gone.
  await page.reload();
  await page.locator('nav.queue .q', { hasText: 'Which size?' }).click();
  await expect(page.locator('.closed-line .tag')).toHaveText('Retracted by agent');
  await expect(draft(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(heard.events.filter((e) => e.type === 'answer')).toEqual([]);
  expect((await cardDetail('drop')).answer).toBeUndefined();
});

test('the draft and its buttons show on a phone in focus mode, and a draft survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await post('phone', 's-phone');
  const heard = inbox.listen('s-phone');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Which size?' }).click();
  await page.locator('.focus-card .focus-toggle').click();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await page.locator('.focus-card textarea').last().fill('Typed on the phone.');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('draft:phone:1'))).toContain('Typed on the phone.');
  await inbox.agent.close('phone', 'self-answered', 'Done already.');
  await expect(draft(page)).toContainText('Typed on the phone.');
  // Nothing the person typed is dropped by a reload either. Focus mode stays on, on the same card.
  await page.reload();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(draft(page)).toContainText('Typed on the phone.');
  const send = draft(page).getByRole('button', { name: 'Send to the agent anyway' });
  await expect(send).toBeInViewport();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'no sideways scroll').toBeLessThanOrEqual(390);
  await send.click();
  await expect.poll(() => heard.events.find((e) => e.type === 'answer')).toBeTruthy();
  const ev = heard.events.find((e) => e.type === 'answer');
  expect(ev?.type === 'answer' && ev.answer.late?.kind).toBe('self-answered');
});
