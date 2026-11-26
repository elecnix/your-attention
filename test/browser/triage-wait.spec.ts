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
  // A verdict that lets it through puts it in its group, once the extension has the card.
  await expect.poll(() => calls.length).toBe(1);
  core.hookVerdict({ token: ext.token.id, role: 'extension' }, calls.at(-1)!.id, 'pass', '');
  await expect(page.locator('.queue .q', { hasText: 'Restart the worker pool?' })).toBeVisible();
  stop();
});

test('a card under triage shows a dot that pulses while the extension checks it', async ({ page }) => {
  const core = inbox.server.inbox;
  const calls: Extract<HookEvent, { hook: 'card.created' }>[] = [];
  const ext = await core.createToken('pulse', 'extension');
  const stop = core.connectExtension({ token: ext.token.id, role: 'extension' }, { name: 'pulse', hooks: ['card.created'] }, (e) => calls.push(e as never));
  const { id } = await inbox.agent.post({ id: 'pulse', agent: 's-pulse', title: 'Rotate the signing key?', text: 'The old one expires in a week.' });
  // The queue hides a card triage still checks, so the address opens it.
  await page.goto(`${inbox.server.url}/#token=${inbox.server.ownerToken}&card=${id}`);
  const dot = page.locator('.triage-dot');
  await expect(dot).toHaveClass(/tone-checking/);
  await expect(dot).toHaveAttribute('title', /^Not triaged yet: pulse is checking this card/);
  const anim = await dot.evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).not.toBe('none');
  // The reduced-motion sheet stops the pulse without the test emulating the media query.
  const reduced = await page.evaluate(() => {
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
      if (!(rule instanceof CSSMediaRule) || !rule.media.mediaText.includes('prefers-reduced-motion: reduce')) continue;
      const inner = [...rule.cssRules].filter((r): r is CSSStyleRule => r instanceof CSSStyleRule);
      const still = inner.find((r) => r.selectorText.trim() === '.triage-dot.tone-checking');
      const centre = inner.find((r) => r.selectorText.trim() === '.triage-dot.tone-checking::before');
      if (still && centre) return { animation: still.style.animationName, display: centre.style.display, opacity: centre.style.opacity };
    }
    return null;
  });
  expect(reduced?.animation).toBe('none');
  // A still dot keeps a centre mark, so a card being checked still differs from a card nobody checked.
  expect(reduced?.display).not.toBe('none');
  expect(Number(reduced?.opacity)).toBeGreaterThan(0);
  expect(Number(reduced?.opacity)).toBeLessThan(1);
  stop();
});
