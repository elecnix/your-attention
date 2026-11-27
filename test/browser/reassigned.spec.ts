// A card whose agent retired: the page says who had it, who has it now and why, and a card that found no living agent
// says so to the person instead of promising a reconnect.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const owner = { token: 'owner', role: 'owner' as const };
// Set SHOTS to a folder to keep a picture of each card, for the pull request.
const shot = (page: import('@playwright/test').Page, name: string) => process.env['SHOTS'] ? page.locator('.focus-card').screenshot({ path: `${process.env['SHOTS']}/${name}.png` }) : undefined;

test('a card that changed hands shows the old agent, the new one and why', async ({ page }) => {
  await inbox.agent.post({ id: 'moved', agent: 'claude:kid', title: 'Which schema for the sessions table?', text: 'Two migrations are ready.', origin: { name: 'fix-login', harness: 'claude-code' } });
  await inbox.agent.post({ id: 'lead-card', agent: 'claude:lead', title: 'Ship the release notes?', origin: { name: 'release lead', harness: 'claude-code' } });
  inbox.server.inbox.reassign(owner, 'moved', { to: 'claude:lead', why: 'fix-login retired' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Which schema for the sessions table?' }).click();
  const note = page.locator('.focus-card .note.reassigned');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Reassigned from fix-login to release lead, because fix-login retired');
  await shot(page, 'reassigned');
});

test('a card with no living ancestor says no agent is left, once, and why', async ({ page }) => {
  await inbox.agent.post({ id: 'left', agent: 'claude:alone', title: 'Rotate the staging key?', text: 'The key expires on Friday.', origin: { name: 'key-rotation', harness: 'claude-code' } });
  inbox.server.inbox.reassign(owner, 'left', { to: null, why: 'key-rotation retired' });
  await inbox.open(page);
  await expect(page.locator('.q .ico.s.orphaned').first()).toHaveAttribute('data-tip', 'not connected');
  await page.locator('.q', { hasText: 'Rotate the staging key?' }).click();
  const focus = page.locator('.focus-card');
  const pill = focus.locator('.pill.off');
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveText('No agent left: key-rotation retired, and no agent above it is alive. The answer waits until another session takes the card');
  await expect(focus.locator('.note.reassigned')).toHaveCount(0);
  await shot(page, 'orphaned');
});
