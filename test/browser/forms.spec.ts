// A card can carry its own forms between its text and tables, so each question sits beside what it asks about.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const body = `root = Card([intro, tbl, pr12, mid, pr13])
intro = TextContent("Two pull requests wait. Decide each one where it is described.")
tbl = Table([Col("PR", ["#12", "#13"]), Col("Risk", ["low", "high"])])
pr12 = Form("pr12", none, [c1, c2])
none = Buttons([])
c1 = FormControl("Merge #12?", r1)
r1 = RadioGroup("merge12", [RadioItem("Merge it", "", "yes"), RadioItem("Wait", "", "no")])
c2 = FormControl("Checks for #12", k1)
k1 = CheckBoxGroup("checks12", [CheckBoxItem("Rerun CI", "", "ci"), CheckBoxItem("Ask a reviewer", "", "review")])
mid = TextContent("#13 changes the deploy script.")
pr13 = Form("pr13", none, [c3, flags])
c3 = FormControl("Merge #13?", s1)
s1 = Select("merge13", [SelectItem("yes", "Merge it"), SelectItem("no", "Wait")])
flags = SwitchGroup("flags13", [SwitchItem("Deploy after merge", "", "deploy")])`;

test('one send carries every form on the card, with the comment the page adds below them', async ({ page }) => {
  await inbox.agent.post({ id: 'forms', agent: 's-forms', title: 'Two pull requests', body, priority: 'now' });
  const ev = inbox.listen('s-forms');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Two pull requests' }).click();
  const card = page.locator('.focus-card');
  await card.getByText('Merge it', { exact: true }).click();
  await card.getByText('Rerun CI').click();
  await card.getByText('Deploy after merge').click();
  await card.locator('textarea').fill('Merge #12 first.');
  await expect(card.getByRole('button', { name: 'Skip for now' })).toBeVisible();
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const a = ev.events.find((e) => e.type === 'answer');
  expect(a?.type === 'answer' && a.answer.values).toEqual({ merge12: 'yes', checks12: { ci: true, review: false }, flags13: { deploy: true } });
  expect(a?.type === 'answer' && a.answer.comment).toBe('Merge #12 first.');
  await page.waitForTimeout(1000);
  await page.locator('.q', { hasText: 'Two pull requests' }).click();
  await expect(page.locator('.note.ok')).toHaveText('Your answer: Merge #12?: Merge it\nChecks for #12: Rerun CI\nDeploy after merge\nMerge #12 first.');
});

test('a card with its own comment field and buttons gets no second comment field', async ({ page }) => {
  const own = `root = Card([f])
f = Form("f", b, [fc])
fc = FormControl("Why?", comment)
comment = TextArea("comment", "Say why", 2)
b = Buttons([go])
go = Button("Decide", @ToAssistant("send answer"), "primary")`;
  await inbox.agent.post({ id: 'own', agent: 's-own', title: 'Own comment field', body: own, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Own comment field' }).click();
  await expect(page.locator('.focus-card textarea')).toHaveCount(1);
  await expect(page.locator('.focus-card').getByRole('button', { name: 'Skip for now' })).toBeVisible();
});

test('the example in the card_post description renders and answers', async ({ page }) => {
  const { cardTools } = await import('../../src/integrations/tools.ts');
  const props = cardTools.find((t) => t.name === 'card_post')?.schema['properties'] as Record<string, { description: string }>;
  const example = props['body']!.description.split('Example:\n')[1]!;
  await inbox.agent.post({ id: 'example', agent: 's-example', title: 'The tool example', body: example, priority: 'now' });
  const ev = inbox.listen('s-example');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'The tool example' }).click();
  const card = page.locator('.focus-card');
  await expect(card.getByText('Duplicate uploads')).toBeVisible();
  await card.getByText('Merge it', { exact: true }).click();
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const a = ev.events.find((e) => e.type === 'answer');
  expect(a?.type === 'answer' && a.answer.values).toEqual({ merge12: 'yes' });
});
