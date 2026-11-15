// The agents panel: who the inbox knows, and the one form that sends a card to the agent its drop-down picks.
import { expect, test, type Page } from '@playwright/test';
import { cardEvents } from '../unit/fixture.ts';
import { openDialog, startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

const PANEL = 'Send a card to an agent';

/** The drop-down that picks the agent a card goes to, and the field the person writes the message in. */
const pick = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('combobox', { name: 'Agent', exact: true });
const message = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('textbox', { name: 'Message', exact: true });

test('picks an agent in the drop-down, shows what presence says about it, and sends it a card', async ({ page }) => {
  // A card from that session is where the inbox learns the name it reports and where it runs.
  await inbox.agent.post({ agent: 'claude:s1', title: 'Deploy the preview?', origin: { harness: 'claude-code', name: 'storage', cwd: '/home/nicolas/Source/acme/api' } });
  // Another card reports a session that holds no connection, so the drop-down has a second name to pick.
  await inbox.agent.post({ agent: 'pi:away', title: 'Which region first?', origin: { harness: 'pi', name: 'release' } });
  // Its session holds a stream open, as the integration does while the session runs.
  const stream = inbox.listen('claude:s1');
  await expect.poll(() => inbox.server.inbox.isOnline('claude:s1')).toBe(true);
  await inbox.open(page);

  const dialog = await openDialog(page, PANEL);
  // One form, one drop-down: both names, the connected agent first, and nothing to pick before the person does.
  await expect(pick(dialog).locator('option')).toHaveText(['storage', 'release']);
  await pick(dialog).selectOption('claude:s1');
  await expect(dialog).toContainText('Connected now');
  await expect(dialog).toContainText('/home/nicolas/Source/acme/api');

  await message(dialog).fill('Please rebase on main before you deploy.');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog).toContainText('Sent to storage');

  // The card the person wrote arrives on that agent's stream, and nowhere else.
  await expect.poll(() => cardEvents(stream.events).length).toBe(1);
  const sent = cardEvents(stream.events)[0];
  expect(sent?.card.title).toBe('Please rebase on main before you deploy.');
  expect(sent?.card.agent).toBe('claude:s1');
});

test('sends with the one button when the inbox knows a single connected agent', async ({ page }) => {
  // This session posts no card, so presence alone puts it in the drop-down, under the id it reports.
  const stream = inbox.listen('pi:solo');
  await expect.poll(() => inbox.server.inbox.isOnline('pi:solo')).toBe(true);
  await inbox.open(page);

  const dialog = await openDialog(page, PANEL);
  await expect(pick(dialog).locator('option')).toHaveText(['pi:solo']);
  await expect(pick(dialog)).toHaveValue('pi:solo');
  await expect(dialog).toContainText('Connected now');

  await message(dialog).fill('Name the release branch after the ticket.');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog).toContainText('Sent to pi:solo');

  await expect.poll(() => cardEvents(stream.events).length).toBe(1);
  expect(cardEvents(stream.events)[0]?.card.agent).toBe('pi:solo');
});

test('says there is nobody to send to when no agent has connected, and offers no send', async ({ page }) => {
  await inbox.open(page);

  const dialog = await openDialog(page, PANEL);
  await expect(dialog).toContainText('Nobody to send to: no agent has connected to this inbox yet.');
  await expect(pick(dialog)).toBeDisabled();
  await expect(message(dialog)).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});

test('says a card waits for an agent that is offline, hands it over when the session connects, and shows that agent offline after it goes', async ({ page }) => {
  await inbox.agent.post({ agent: 'pi:away', title: 'Which region first?', origin: { harness: 'pi', name: 'release', cwd: '/home/nicolas/Source/acme/release' } });
  await inbox.open(page);

  const dialog = await openDialog(page, PANEL);
  await expect(pick(dialog).locator('option')).toHaveText(['release']);
  await expect(dialog).toContainText('Never connected');
  await message(dialog).fill('Ping me when the run is done.');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog).toContainText('Waiting for release: it is offline');

  // The session connects later, and the card that waited arrives then.
  const stream = inbox.listen('pi:away');
  await expect.poll(() => cardEvents(stream.events).length).toBe(1);
  const sent = cardEvents(stream.events)[0];
  expect(sent?.card.title).toBe('Ping me when the run is done.');

  // When it goes, the state line reads it as offline with when the inbox last saw it, and never as connected.
  stream.stop();
  await expect(dialog).toContainText('Last seen');
  await expect(dialog).not.toContainText('Connected now');
});
