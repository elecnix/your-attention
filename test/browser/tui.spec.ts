// The terminal client parses card bodies with the page's component list and must answer as the page does:
// for the same picks, both send the same values.
import { expect, test } from '@playwright/test';
import { buildQueue, type InboxState } from '../../web/queue.js';
import type { Card } from '../../src/core/types.ts';
import { loadParser } from '../../src/tui/body.ts';
import { CardView } from '../../src/tui/cardview.ts';
import { makeTheme } from '../../src/tui/theme.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); await loadParser(); });
test.afterAll(async () => { await inbox.close(); });

/** The terminal client's answer for a card, after picking with keys: each step focuses a stop, then presses keys. */
function terminalAnswer(card: Card, steps: [string, string[]][], typed: Record<string, string> = {}) {
  const view = new CardView(card, { theme: makeTheme({ color: 0, unicode: true, hyperlinks: false }), address: () => '', act: () => {}, fileText: () => undefined, now: () => Date.now() });
  const s: InboxState = { cards: [card], answers: {}, presence: {}, states: { [card.id]: 'open' } };
  const build = () => view.build(80, s, buildQueue(s, 'none'));
  build();
  for (const [stop, keys] of steps) {
    view.focus = stop;
    build();
    for (const k of keys) { view.key({ type: 'key', name: k, ctrl: false, alt: false, shift: false }); build(); }
  }
  for (const [stop, text] of Object.entries(typed)) {
    view.focus = stop;
    build();
    for (const ch of text) { view.key({ type: 'key', name: ch, text: ch, ctrl: false, alt: false, shift: false }); build(); }
  }
  return view.answer();
}

test('the page and the terminal client send the same values for the same picks', async ({ page }) => {
  const body = 'root = Card([f, g])\nf = Form("f", none, [c1, c2, c3])\nnone = Buttons([])\nc1 = FormControl("Merge?", RadioGroup("merge", [RadioItem("Merge it", "", "yes"), RadioItem("Wait", "", "no")]))\nc2 = FormControl("Checks", CheckBoxGroup("checks", [CheckBoxItem("Rerun CI", "", "ci"), CheckBoxItem("Ask a reviewer", "", "review", true)]))\nc3 = FormControl("Pick", OptionCards("pick", "multiple", [OptionCard("a", "Alpha"), OptionCard("b", "Beta")], {}, ["a"]))\ng = Form("g", none, [c4])\nc4 = FormControl("Ticket", Input("ticket", "Ticket"))';
  const posted = await inbox.agent.post({ id: 'parity', agent: 's-parity', title: 'Parity card', priority: 'now', body, options: [{ id: 'o1', label: 'One' }] });
  const ev = inbox.listen('s-parity');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Parity card' }).click();
  const card = page.locator('.focus-card');
  await card.getByText('Merge it', { exact: true }).click();
  await card.getByText('Rerun CI').click();
  await card.getByText('Beta').click();
  await card.getByPlaceholder('Ticket').fill('T-7');
  await card.locator('textarea').last().fill('Looks good.');
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const sent = ev.events.find((e) => e.type === 'answer');
  const tui = terminalAnswer(posted, [['field:f/merge', ['space']], ['field:f/checks', ['space']], ['field:f/pick', ['down', 'space']]], { 'field:g/ticket': 'T-7', 'field:yaAnswer/comment': 'Looks good.' });
  expect(sent?.type === 'answer' && { values: sent.answer.values, comment: sent.answer.comment }).toEqual(tui);
});
