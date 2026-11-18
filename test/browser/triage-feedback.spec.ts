// The owner reads, on a card, each time triage pushed back on it and what the agent said about it: a collapsed
// "Triage pushback" section beside the card's changes.
import { expect, test } from '@playwright/test';
import type { HookEvent } from '../../src/core/hooks.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('a card triage sent back shows the reason and the agent\'s feedback, collapsed until the owner opens it', async ({ page }) => {
  const core = inbox.server.inbox;
  const calls: Extract<HookEvent, { hook: 'card.created' }>[] = [];
  const ext = await core.createToken('triage', 'extension');
  const stop = core.connectExtension({ token: ext.token.id, role: 'extension' }, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e as never));
  const verdict = (v: 'pass' | 'return', reason: string) => core.hookVerdict({ token: ext.token.id, role: 'extension' }, calls.at(-1)!.id, v, reason);
  await inbox.agent.post({ id: 'tf', agent: 's-tf', title: 'Retry the nightly export?', text: 'It failed twice.' });
  verdict('return', 'The card states no goal, and the option Keep paging has no description.');
  await inbox.agent.triageFeedback('tf', { verdict: 'partly', comment: 'The goal is in the title.', findings: [{ index: 1, verdict: 'disagree', comment: 'The title says it.' }, { index: 2, verdict: 'agree' }] });
  await inbox.agent.post({ id: 'tf', agent: 's-tf', title: 'Retry the nightly export?', text: 'Goal: a full export by 6:00. It failed twice.' });
  verdict('pass', '');
  stop();

  await inbox.open(page);
  await page.locator('.q', { hasText: 'Retry the nightly export?' }).click();
  const section = page.locator('.focus-card details.pushback');
  await expect(section.locator('summary')).toHaveText('Triage pushback (1), agent feedback on 1');
  await expect(section.locator('.reason')).toBeHidden();
  await section.locator('summary').click();
  await expect(section.locator('.step-head')).toContainText('Version 1: triage sent it back');
  await expect(section.locator('.reason')).toHaveText('The card states no goal, and the option Keep paging has no description.');
  await expect(section.locator('.feedback.partly .field')).toContainText('The agent partly agrees');
  await expect(section.locator('.feedback .comment')).toHaveText('The goal is in the title.');
  await expect(section.locator('.findings li')).toHaveText(['Finding 1: disagrees. The title says it.', 'Finding 2: agrees']);
});
