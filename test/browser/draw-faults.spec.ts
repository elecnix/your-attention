// The hosted inbox takes diagrams and bodies unchecked. When the page cannot draw one, it tells the inbox, and the card goes
// back to its agent with the errors. The tests write each card straight into storage, as a raw post to the hosted inbox stores it,
// and hide the laptop's bodyFallback from the page, as the hosted inbox sends none.
import { expect, test, type Page } from '@playwright/test';
import { bodyErrors } from '../../src/adapters/openui-body.ts';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

/** Post a card that checks, then store the fields the agent's client would have refused. */
async function stored(id: string, agent: string, fields: Partial<Card>): Promise<void> {
  await inbox.agent.post({ id, agent, title: `Unchecked ${id}`, priority: 'now', text: 'Placeholder.' });
  const store = inbox.server.inbox['store'];
  store.put('cards', id, { ...store.get<Card>('cards', id), ...fields });
}

/** The page sees the cards the hosted inbox sends, which have no bodyFallback. */
const asHosted = (page: Page) => page.route(/\/v1\/cards\/[^/]+$/, async (route) => {
  if (route.request().method() !== 'GET') return route.fallback();
  const res = await route.fetch();
  const { card: { bodyFallback: _, ...card }, ...rest } = (await res.json()) as { card: Card };
  await route.fulfill({ response: res, json: { ...rest, card } });
});

const returned = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: 'returned' }> => e.type === 'returned');

test('a diagram the page cannot draw shows its source, and goes back to the agent with mermaid\'s words', async ({ page }) => {
  await stored('bad-flow', 's-bad-flow', { text: 'See:\n\n```mermaid\nflowchart TD\n  A -. text .->|label| B\n```' });
  const heard = inbox.listen('s-bad-flow');
  await asHosted(page);
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Unchecked bad-flow' }).click();
  await expect(page.locator('.focus-card .diagram-source')).toContainText('A -. text .->|label| B');
  await expect.poll(() => returned(heard.events)?.reason ?? '').toMatch(/The Mermaid diagram in text, the diagram on line 3 does not parse, so the page could not draw it, and the inbox sent the card back\. Mermaid 11\.17\.2 says:\n.*Parse error on line 2/s);
  expect(returned(heard.events)?.by).toBe('The inbox page');
  await expect(page.locator('.closed-line')).toContainText('Sent back to its agent');
});

test('a body the page draws only in part draws the same fallback as the laptop inbox, and goes back with the same faults', async ({ page }) => {
  const body = 'root = Card([intro, f1])\nintro = TextContent("Two fixes.")\nnone = Buttons([])\nf1 = Form(\\"f1\\", none, [TextContent(\\"The second fix.\\")])';
  await stored('bad-body', 's-bad-body', { text: undefined, body });
  const heard = inbox.listen('s-bad-body');
  await asHosted(page);
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Unchecked bad-body' }).click();
  const card = page.locator('.focus-card');
  await expect(card.locator('.note.warn').first()).toContainText('did not draw');
  await expect(card.locator('.openui-card').first()).toContainText('Two fixes.');
  await expect(card.locator('.body-source .openui-code-block-syntax-highlighter')).toContainText('The second fix.');
  await expect.poll(() => returned(heard.events)?.reason ?? '').toBe(`the page cannot draw all of this body, so the inbox sent the card back:\n- ${bodyErrors(body).join('\n- ')}`);
});

test('a laptop inbox sends the fallback of a body it stored before it checked, and the page keeps the card', async ({ page }) => {
  await stored('old-body', 's-old-body', { text: undefined, body: 'root = Card([a, b])\na = TextContent("x")\nb = TextContent(\\"y\\")' });
  const heard = inbox.listen('s-old-body');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Unchecked old-body' }).click();
  await expect(page.locator('.focus-card .note.warn').first()).toContainText('did not draw');
  await page.waitForTimeout(1000);
  expect(returned(heard.events)).toBeUndefined();
  expect((await inbox.state()).states['old-body']).toBe('open');
});
