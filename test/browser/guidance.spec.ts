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
  await inbox.agent.proposeGuidance(p.text, 's-guide');
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
  const card = await inbox.agent.proposeGuidance(p.text, 's-guide');
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
  await inbox.agent.proposeGuidance(p.text, 's-guide');
  await inbox.open(page);
  await page.route('**/v1/cards/*/answer', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'the inbox is restarting' }) }));
  await page.getByLabel('Comment').fill('Keep this comment.');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.locator('.broadcast .note.warn')).toContainText('the inbox is restarting');
  await expect(page.getByLabel('Comment')).toHaveValue('Keep this comment.');
  await expect(page.locator('.card-title')).toHaveText('Send new card guidance to agents?');
});

test('a proposal that matches the current guidance says so', async ({ page }) => {
  await inbox.agent.proposeGuidance((await inbox.agent.guidance()).text, 's-guide');
  await inbox.open(page);
  await expect(page.locator('.guidance-diff')).toContainText('The proposal matches the current guidance.');
});
