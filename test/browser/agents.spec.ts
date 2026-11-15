// The agents panel: who the inbox knows, and the one form that sends a card to the agent its drop-down picks.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { cardEvents } from '../unit/fixture.ts';
import { openDialog, startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

const PANEL = 'Send a card to an agent';

/** The drop-down that picks the agent a card goes to, and the field the person writes the message in. */
const pick = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('combobox', { name: 'Agent', exact: true });
const message = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('textbox', { name: 'Message', exact: true });

/** What the browser draws behind a button, as the page's accent color reads on the same page. */
const backdrop = (button: Locator) => button.evaluate((el) => getComputedStyle(el).backgroundColor);
const accentOf = (dialog: Locator) => dialog.evaluate((el) => {
  const probe = document.createElement('span');
  probe.style.color = 'var(--accent)';
  el.appendChild(probe);
  const accent = getComputedStyle(probe).color;
  probe.remove();
  return accent;
});

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

test('keeps a message typed while a send is still in flight, and clears the field when it holds what went', async ({ page }) => {
  // A session holds its stream open, so the panel has an agent to send to before the person writes.
  const stream = inbox.listen('pi:solo');
  await expect.poll(() => inbox.server.inbox.isOnline('pi:solo')).toBe(true);
  await inbox.open(page);

  const dialog = await openDialog(page, PANEL);
  // Hold the send open, which is the moment the person starts the next message.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/v1/send', async (route) => { await held; await route.continue(); });
  await message(dialog).fill('Rebase on main before you deploy.');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await message(dialog).fill('Then run the release.');

  // The reply lands: the message it carried went, and the one the person typed after it stays in the field.
  release();
  await expect(dialog).toContainText('Sent to pi:solo');
  await expect(message(dialog)).toHaveValue('Then run the release.');

  // A send that nobody typed over empties the field, since it still holds the message that went.
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(message(dialog)).toHaveValue('');
  await expect.poll(() => cardEvents(stream.events).length).toBe(2);
  expect(cardEvents(stream.events).map((e) => e.card.title)).toEqual(['Rebase on main before you deploy.', 'Then run the release.']);
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

test('puts Send and Close on one row, with Send as the primary action of the dialog', async ({ page }) => {
  // A session holds its stream open, so the panel has an agent to send to and the row shows in its usual state.
  inbox.listen('pi:solo');
  await expect.poll(() => inbox.server.inbox.isOnline('pi:solo')).toBe(true);
  await inbox.open(page);

  const dialog = await openDialog(page, PANEL);
  const send = dialog.getByRole('button', { name: 'Send', exact: true });
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const [s, c] = [(await send.boundingBox())!, (await close.boundingBox())!];
  // One row: the middle of each button sits at the same height, and Send reads first, on the left.
  expect(Math.abs(s.y + s.height / 2 - (c.y + c.height / 2))).toBeLessThan(2);
  expect(s.x + s.width).toBeLessThanOrEqual(c.x);

  // Send wears the accent a primary action takes, and Close keeps the quiet look the other dialogs give it.
  const accent = await accentOf(dialog);
  expect(await backdrop(send)).toBe(accent);
  expect(await backdrop(close)).not.toBe(accent);
  await expect(send).toHaveClass(/primary/);
  await expect(close).not.toHaveClass(/primary/);
});
