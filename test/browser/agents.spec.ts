// The agents panel: who the inbox knows, and a card the person sends one of them.
import { expect, test, type Page } from '@playwright/test';
import type { AgentEvent } from '../../src/core/types.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

const PANEL = 'Send a card to an agent';

/** Open the panel, as the person does with the people-shaped button in the bar. */
async function openPanel(page: Page) {
  await page.getByRole('button', { name: PANEL }).click();
  const dialog = page.getByRole('dialog', { name: PANEL });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The panel's row for one agent, found by the session name it reports. */
const rowOf = (dialog: ReturnType<Page['locator']>, name: string) => dialog.locator('li', { hasText: name });

/** The cards the person sent, as the agent's stream received them. */
const cardsSeen = (events: AgentEvent[]): Extract<AgentEvent, { type: 'card' }>[] => events.filter((e): e is Extract<AgentEvent, { type: 'card' }> => e.type === 'card');

test('lists a connected agent with the session name and folder its card reported, and sends it a card', async ({ page }) => {
  // A card from that session is where the inbox learns the name it reports and where it runs.
  await inbox.agent.post({ agent: 'claude:s1', title: 'Deploy the preview?', origin: { harness: 'claude-code', name: 'storage', cwd: '/home/nicolas/Source/acme/api' } });
  // Its session holds a stream open, as the integration does while the session runs.
  const stream = inbox.listen('claude:s1');
  await expect.poll(() => inbox.server.inbox.isOnline('claude:s1')).toBe(true);
  await inbox.open(page);

  const dialog = await openPanel(page);
  const row = rowOf(dialog, 'storage');
  await expect(row).toContainText('storage');
  await expect(row).toContainText('/home/nicolas/Source/acme/api');
  await expect(row).toContainText('Connected now');

  await row.getByRole('textbox', { name: 'Message to storage' }).fill('Please rebase on main before you deploy.');
  await row.getByRole('button', { name: 'Send' }).click();
  await expect(row).toContainText('Sent to storage');

  // The card the person wrote arrives on that agent's stream, and nowhere else.
  await expect.poll(() => cardsSeen(stream.events).length).toBe(1);
  const sent = cardsSeen(stream.events)[0];
  expect(sent?.card.title).toBe('Please rebase on main before you deploy.');
  expect(sent?.card.agent).toBe('claude:s1');
});

test('says a card waits for an agent that is offline, hands it over when the session connects, and shows that agent offline after it goes', async ({ page }) => {
  await inbox.agent.post({ agent: 'pi:away', title: 'Which region first?', origin: { harness: 'pi', name: 'release', cwd: '/home/nicolas/Source/acme/release' } });
  await inbox.open(page);

  const dialog = await openPanel(page);
  const row = rowOf(dialog, 'release');
  await expect(row).toContainText('Never connected');
  await row.getByRole('textbox', { name: 'Message to release' }).fill('Ping me when the run is done.');
  await row.getByRole('button', { name: 'Send' }).click();
  await expect(row).toContainText('Waiting for release: it is offline');

  // The session connects later, and the card that waited arrives then.
  const stream = inbox.listen('pi:away');
  await expect.poll(() => cardsSeen(stream.events).length).toBe(1);
  const sent = cardsSeen(stream.events)[0];
  expect(sent?.card.title).toBe('Ping me when the run is done.');

  // When it goes, the panel reads it as offline with when the inbox last saw it, and never as connected.
  stream.stop();
  await expect(row).toContainText('Last seen');
  await expect(row).not.toContainText('Connected now');
});
