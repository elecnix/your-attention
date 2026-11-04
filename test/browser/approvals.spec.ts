import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
const sent: [string, string][] = [];
test.beforeAll(async () => {
  inbox = await startInbox({ approvals: {
    send: async (pane, text) => { sent.push([pane, text]); },
    describe: async (pane) => (pane === 'w6P:p2' ? { agent: 'claude', title: 'release', tab: 'login fix', workspace: 'DevEx' } : {}),
  } });
});
test.afterAll(async () => { await inbox.close(); });

test('the person approves one sentence beside an option, and the inbox sends that one alone', async ({ page }) => {
  await inbox.agent.post({
    id: 'approve', agent: 's-approve', title: 'Push the release tag?', priority: 'now',
    options: [{ id: 'o1', label: 'Push now' }, { id: 'o2', label: 'Wait' }],
    approvals: [{ pane: 'w6P:p2', text: 'Yes, push the tag v1.2.0.', label: 'Push the tag' }, { pane: 'w7:p3', text: 'Yes, delete the old branch.' }],
  });
  await inbox.open(page);
  const first = page.locator('.approval').nth(0);
  const second = page.locator('.approval').nth(1);
  await expect(first.locator('pre code')).toHaveText('Yes, push the tag v1.2.0.');
  await expect(first).toContainText('Push the tag');
  await expect(first.getByRole('link', { name: 'Open pane' })).toHaveAttribute('href', 'https://herdr.invalid/v1/pane/w6P:p2');
  await expect(first.locator('.approval-place')).toHaveText('Pane w6P:p2 · claude, release · tab login fix in workspace DevEx');
  await expect(second.locator('.approval-place')).toHaveText('Pane w7:p3');

  const toggle = first.getByRole('button', { name: 'Approve' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(first.getByRole('button', { name: 'Approved' })).toHaveAttribute('aria-pressed', 'true');
  // A second click turns it off again, and a third on.
  await first.getByRole('button', { name: 'Approved' }).click();
  await expect(first.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'false');
  await first.getByRole('button', { name: 'Approve' }).click();

  await page.getByText('Push now', { exact: true }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(async () => (await inbox.state()).answers['approve']?.values).toEqual({ choice: 'o1', approval_0: true, approval_1: false });
  await expect.poll(() => sent).toEqual([['w6P:p2', 'Yes, push the tag v1.2.0.']]);

  await page.locator('.q', { hasText: 'Push the release tag?' }).click();
  await expect(page.locator('.approval').nth(0).locator('.approval-result')).toContainText('Sent to w6P:p2 at');
  await expect(page.locator('.approval').nth(1).locator('.approval-result')).toHaveCount(0);
});
