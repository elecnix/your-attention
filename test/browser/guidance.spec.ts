// The card that asks the person to approve new card guidance: the proposal as a diff against the current guidance,
// and the comment that goes with the answer to the agent that proposed the text.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

/** The current guidance with one word changed on its first line of three words or more, and one line added at the end. */
async function proposal(): Promise<{ edited: string; word: string; added: string; text: string; same: number }> {
  const lines = (await inbox.agent.guidance()).text.split('\n');
  const at = lines.findIndex((l) => l.split(' ').length >= 3);
  if (at < 0) throw new Error('these tests edit a word in a guidance line of three words or more, and the default guidance has none');
  const words = lines[at]!.split(' ');
  words[1] = 'Xyzzy';
  const edited = words.join(' ');
  const added = 'Attach a screenshot to every UI card.';
  const next = [...lines];
  next[at] = edited;
  return { edited, word: 'Xyzzy', added, text: [...next, added].join('\n'), same: lines.length - 1 };
}

test('a guidance card shows one added line, one changed line with its word marked, and hides the unchanged lines', async ({ page }) => {
  const p = await proposal();
  await inbox.agent.proposeGuidance(p.text, { message: 'Adds a rule the last four cards needed.', agent: 's-guide' });
  await inbox.open(page);
  await expect(page.locator('.card-title')).toHaveText('Send new card guidance to agents?');
  const diff = page.locator('.guidance-diff');
  await expect(diff.locator('.del')).toHaveCount(1);
  await expect(diff.locator('.add')).toHaveCount(2);
  await expect(diff.locator('.add mark')).toHaveText([p.word]);
  await expect(diff.locator('.del mark')).toHaveCount(1);
  await expect(diff.locator('.add').nth(0)).toContainText(p.edited);
  await expect(diff.locator('.add').nth(1)).toHaveText(`+ ${p.added}`);
  await expect(diff.locator('.same')).toHaveCount(0);
  await page.getByRole('button', { name: /Show the full text/ }).click();
  await expect(diff.locator('.same')).toHaveCount(p.same);
});

test('a comment and Reject go to the agent that proposed the guidance', async ({ page }) => {
  const heard = inbox.listen('s-guide');
  const p = await proposal();
  const card = await inbox.agent.proposeGuidance(p.text, { message: 'Adds a rule the last four cards needed.', agent: 's-guide' });
  await inbox.open(page);
  await expect(page.locator('.card-title')).toHaveText('Send new card guidance to agents?');
  await page.getByLabel('Comment').fill('Name the widget instead of the screenshot.');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect.poll(() => heard.events.find((e) => e.type === 'answer')).toBeTruthy();
  const ev = heard.events.find((e) => e.type === 'answer');
  expect(ev?.type === 'answer' && ev.card.id).toBe(card.id);
  expect(ev?.type === 'answer' && ev.answer.values['choice']).toBe('reject');
  expect(ev?.type === 'answer' && ev.answer.comment).toBe('Name the widget instead of the screenshot.');
  expect((await inbox.agent.guidance()).text).not.toContain(p.added);
});

test('a guidance answer that fails keeps the comment and says why', async ({ page }) => {
  const p = await proposal();
  await inbox.agent.proposeGuidance(p.text, { message: 'Adds a rule the last four cards needed.', agent: 's-guide' });
  await inbox.open(page);
  await page.route('**/v1/cards/*/answer', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'the inbox is restarting' }) }));
  await page.getByLabel('Comment').fill('Keep this comment.');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.locator('.broadcast .note.warn')).toContainText('the inbox is restarting');
  await expect(page.getByLabel('Comment')).toHaveValue('Keep this comment.');
  await expect(page.locator('.card-title')).toHaveText('Send new card guidance to agents?');
});

test('a proposal that matches the current guidance says so', async ({ page }) => {
  await inbox.agent.proposeGuidance((await inbox.agent.guidance()).text, { message: 'Adds a rule the last four cards needed.', agent: 's-guide' });
  await inbox.open(page);
  await expect(page.locator('.guidance-diff')).toContainText('The proposal matches the current guidance.');
});

test('the card lists only the agents online now, all ticked, out of many that connected once', async ({ page }) => {
  const gone = Array.from({ length: 30 }, (_, i) => inbox.listen(`s-gone-${i}`));
  const presence = async () => ((await inbox.state()) as unknown as { presence: Record<string, { online: boolean }> }).presence;
  await expect.poll(async () => Object.keys(await presence()).filter((a) => a.startsWith('s-gone-')).length).toBe(30);
  for (const g of gone) g.stop();
  await expect.poll(async () => Object.entries(await presence()).filter(([a, p]) => a.startsWith('s-gone-') && p.online).length, { timeout: 10_000 }).toBe(0);
  const online = ['s-on-1', 's-on-2', 's-on-3'].map((a) => inbox.listen(a));
  await expect.poll(async () => Object.entries(await presence()).filter(([a, p]) => a.startsWith('s-on-') && p.online).length).toBe(3);
  const card = await inbox.agent.proposeGuidance('Always attach a screenshot.', { message: 'Adds a rule the last four cards needed.', agent: 's-on-1' });
  const stored = (await inbox.state()).cards.find((c) => c.id === card.id);
  expect(stored?.broadcast?.agents).toBeUndefined();
  expect(JSON.stringify(stored)).not.toContain('s-gone-');
  await inbox.open(page);
  const agents = page.locator('.broadcast .agents');
  await expect(agents.locator('legend')).toHaveText('Send to 3 online agents');
  await expect(agents.locator('.agent input[type=checkbox]')).toHaveCount(3);
  await expect(agents.locator('.agent input[type=checkbox]:checked')).toHaveCount(3);
  await expect(agents).toContainText('Offline agents get the new guidance when they reconnect, or when they call card_guidance.');
  await expect(agents).not.toContainText('s-gone-');
  // The proposing agent's message says why, above the diff.
  await expect(page.locator('.broadcast .broadcast-message')).toHaveText('Adds a rule the last four cards needed.');
  online[2]!.stop();
  await expect(agents.locator('legend')).toHaveText('Send to 2 online agents', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Approve and send' }).click();
  await expect.poll(async () => (await inbox.state()).answers[card.id]?.values['agents']).toEqual(['s-on-1', 's-on-2']);
});

test('one toggle unticks every agent, a newcomer joins unticked, and the toggle shows a partial pick', async ({ page }) => {
  const presence = async () => ((await inbox.state()) as unknown as { presence: Record<string, { online: boolean }> }).presence;
  ['s-a', 's-b', 's-c'].map((a) => inbox.listen(a));
  await expect.poll(async () => Object.entries(await presence()).filter(([a, p]) => /^s-[abc]$/.test(a) && p.online).length).toBe(3);
  const card = await inbox.agent.proposeGuidance('Always attach a screenshot.', { message: 'Adds a rule the last four cards needed.', agent: 's-a' });
  await inbox.open(page);
  const agents = page.locator('.broadcast .agents');
  const all = agents.getByRole('checkbox', { name: 'All agents' });
  await expect(all).toBeChecked();
  // The box heads the list, heavier than the agent rows under it.
  expect(Number(await agents.locator('.all').evaluate((e) => getComputedStyle(e).fontWeight))).toBeGreaterThanOrEqual(600);
  await all.uncheck();
  await expect(agents.locator('.agent input[type=checkbox]:checked')).toHaveCount(0);
  // An agent that comes online after the person unticked them all joins unticked too.
  inbox.listen('s-d');
  await expect(agents.locator('.agent input[type=checkbox]')).toHaveCount(4, { timeout: 10_000 });
  await expect(agents.locator('.agent input[type=checkbox]:checked')).toHaveCount(0);
  await agents.locator('.agent', { hasText: 's-b' }).locator('input').check();
  expect(await all.evaluate((e) => (e as HTMLInputElement).indeterminate)).toBe(true);
  await page.getByRole('button', { name: 'Approve and send' }).click();
  await expect.poll(async () => (await inbox.state()).answers[card.id]?.values['agents']).toEqual(['s-b']);
});

test('unticking every agent by hand also makes a newcomer join unticked', async ({ page }) => {
  const presence = async () => ((await inbox.state()) as unknown as { presence: Record<string, { online: boolean }> }).presence;
  ['s-x', 's-y'].map((a) => inbox.listen(a));
  await expect.poll(async () => Object.entries(await presence()).filter(([a, p]) => /^s-[xy]$/.test(a) && p.online).length).toBe(2);
  const card = await inbox.agent.proposeGuidance('Always attach a screenshot.', { message: 'Adds a rule the last four cards needed.', agent: 's-x' });
  await inbox.open(page);
  const agents = page.locator('.broadcast .agents');
  await agents.locator('.agent', { hasText: 's-x' }).locator('input').uncheck();
  await agents.locator('.agent', { hasText: 's-y' }).locator('input').uncheck();
  inbox.listen('s-z');
  await expect(agents.locator('.agent input[type=checkbox]')).toHaveCount(3, { timeout: 10_000 });
  await expect(agents.locator('.agent input[type=checkbox]:checked')).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve and send' }).click();
  await expect.poll(async () => (await inbox.state()).answers[card.id]?.values['agents']).toEqual([]);
});
