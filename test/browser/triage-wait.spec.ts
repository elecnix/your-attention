// A card triage is still checking has no verdict yet, and the queue hides it until one arrives: a heading that fills for
// a few seconds and empties again only distracts the person from the cards that wait for them.
import { expect, test } from '@playwright/test';
import type { HookEvent } from '../../src/core/hooks.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('a card under triage stays out of the queue until a verdict lets it through', async ({ page }) => {
  const core = inbox.server.inbox;
  const calls: Extract<HookEvent, { hook: 'card.created' }>[] = [];
  const ext = await core.createToken('triage', 'extension');
  const stop = core.connectExtension({ token: ext.token.id, role: 'extension' }, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e as never));
  await inbox.agent.post({ id: 'tw', agent: 's-tw', title: 'Restart the worker pool?', text: 'Every restart drops a request.' });
  await inbox.open(page);
  // While triage checks it, the card appears nowhere: not in the list, and under no heading of its own.
  await expect(page.locator('.queue', { hasText: 'Restart the worker pool?' })).toHaveCount(0);
  await expect(page.locator('.queue h3', { hasText: 'Being checked' })).toHaveCount(0);
  // A verdict that lets it through puts it in its group.
  core.hookVerdict({ token: ext.token.id, role: 'extension' }, calls.at(-1)!.id, 'pass', '');
  await expect(page.locator('.queue .q', { hasText: 'Restart the worker pool?' })).toBeVisible();
  stop();
});
