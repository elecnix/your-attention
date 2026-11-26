// A card whose agent has no connection: the page says that once, as what the inbox knows, and never claims the
// session is gone or offline, since the inbox cannot see the session itself.
import { expect, test } from '@playwright/test';
import type { Card } from '../../src/core/types.ts';
import type { Storage } from '../../src/core/storage.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('an orphaned card shows exactly one disconnected notice, and its list icon keeps the hover text', async ({ page }) => {
  await inbox.agent.post({ id: 'gone', agent: 'claude:quiet', title: 'Merge the release?', text: 'The build is green.' });
  // Two hours pass with no connection from that session, so the inbox reads the card as orphaned.
  const store = (inbox.server.inbox as unknown as { store: Storage }).store;
  const card = store.get<Card>('cards', 'gone')!;
  const old = Date.now() - 2 * 60 * 60 * 1000;
  store.put('cards', 'gone', { ...card, createdAt: old, updatedAt: old });
  await inbox.open(page);
  await expect(page.locator('.q .ico.s.orphaned').first()).toHaveAttribute('data-tip', 'not connected');
  await page.locator('.q', { hasText: 'Merge the release?' }).click();

  const focus = page.locator('.focus-card');
  const notice = focus.locator('.pill.off');
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText('Not connected: the answer waits until this session reconnects, and another session can take the card');
  // That pill is the whole notice: no state label beside it, and neither old wording anywhere on the card.
  await expect(focus.locator('.status.warn')).toHaveCount(0);
  await expect(focus).not.toContainText('its agent is gone');
  await expect(focus).not.toContainText('offline');
});
