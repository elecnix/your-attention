// The page and the inbox read a card body with the same component list. A body stored before the inbox checked bodies,
// which the page draws only in part, shows its source and stays answerable. The card a card follows shows its text as Markdown.
import { expect, test } from '@playwright/test';
import { LIBRARY } from '../../src/adapters/openui-library.ts';
import type { Card } from '../../src/core/types.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('the page draws with the component list the inbox checks bodies against', async ({ page }) => {
  await inbox.open(page);
  const schema = await page.evaluate(async () => (await import(String('/components.js'))).librarySchema());
  expect(JSON.parse(JSON.stringify(schema))).toEqual(LIBRARY);
});

test('the inbox refuses a body whose string never closes, and names the statement', async () => {
  const body = 'root = Card([intro, f1, f2])\nintro = TextContent("Two fixes.")\nnone = Buttons([])\nf1 = Form(\\"f1\\", none, [TextContent(\\"One\\")])\nf2 = TextContent(\\"Two\\")';
  await expect(inbox.agent.post({ id: 'refused', agent: 's-refused', title: 'Refused?', body })).rejects.toThrow(/`f1` \(line 4\) has a string that never closes/);
});

test('a stored body the page cannot draw whole shows its source, and the card still takes a comment', async ({ page }) => {
  const body = `root = Card([intro, f1])\nintro = TextContent("Two fixes.")\nnone = Buttons([])\nf1 = Form(\\"f1\\", none, [TextContent(\\"The second fix. ${'It is a long line. '.repeat(20)}\\")])`;
  await inbox.agent.post({ id: 'stored-broken', agent: 's-broken', title: 'Stored broken body', priority: 'now', body: 'root = Card([intro])\nintro = TextContent("Two fixes.")' });
  // Write the body as an inbox from before the check stored it.
  const store = inbox.server.inbox['store'];
  store.put('cards', 'stored-broken', { ...store.get<Card>('cards', 'stored-broken'), body });
  const heard = inbox.listen('s-broken');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Stored broken body' }).click();
  const card = page.locator('.focus-card');
  await expect(card.locator('.note.warn')).toContainText('did not draw');
  await expect(card).toContainText('The second fix.');
  // The source wraps, so the person reads every line without scrolling sideways.
  const pre = card.locator('.body-source .openui-code-block-syntax-highlighter');
  expect(await pre.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await card.getByPlaceholder('Anything to add?').fill('Fix the body.');
  await card.locator('button', { hasText: 'Send answer' }).click();
  await expect.poll(() => heard.events.some((e) => e.type === 'answer' && e.answer.comment === 'Fix the body.')).toBe(true);
});

test('a stored broken body that the agent fixes draws as a card again', async ({ page }) => {
  await inbox.agent.post({ id: 'fixed-later', agent: 's-fixed', title: 'Fixed later', priority: 'now', body: 'root = Card([a])\na = TextContent("x")' });
  const store = inbox.server.inbox['store'];
  store.put('cards', 'fixed-later', { ...store.get<Card>('cards', 'fixed-later'), body: 'root = Card([a, b])\na = TextContent("x")\nb = TextContent(\\"y\\")' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Fixed later' }).click();
  const card = page.locator('.focus-card');
  await expect(card.locator('.note.warn')).toContainText('did not draw');
  await card.getByPlaceholder('Anything to add?').fill('Typed before the fix.');
  await inbox.agent.post({ id: 'fixed-later', agent: 's-fixed', title: 'Fixed later', priority: 'now', body: 'root = Card([a, b])\na = TextContent("x")\nb = TextContent("The fixed body.")' });
  await expect(card).toContainText('The fixed body.');
  await expect(card.locator('.note.warn')).toHaveCount(0);
  // What the person typed stays in the comment box when the card draws again.
  await expect(card.getByPlaceholder('Anything to add?')).toHaveValue('Typed before the fix.');
});

test('the card a card follows shows its text as Markdown, with its table and code', async ({ page }) => {
  await inbox.agent.post({ id: 'before', agent: 's-chain', title: 'Apply the tables first?', priority: 'soon',
    text: '**Why:** the tables gain columns.\n\n| Table | New column |\n| -- | -- |\n| `EVENTS` | `HASH` |\n\n```\ngh workflow run apply.yml\n```' });
  await inbox.agent.post({ id: 'after', agent: 's-chain', title: 'Ship with tweaks?', priority: 'now', text: 'The audit is done.', follows: 'before' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Ship with tweaks?' }).click();
  const earlier = page.locator('.focus-card details.earlier');
  await earlier.locator('summary').click();
  await expect(earlier.locator('table td').first()).toHaveText('EVENTS');
  await expect(earlier.locator('pre')).toContainText('gh workflow run apply.yml');
  await expect(earlier.locator('strong', { hasText: 'Why:' })).toBeVisible();
  await expect(earlier).not.toContainText('| --');
});
