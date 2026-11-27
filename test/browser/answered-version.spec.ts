// An answer names the card version the person read. When the agent revises the card after that, the card says which
// version the person answered, where the page shows the answer, so the revision leaves a trace.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeEach(async () => { inbox = await startInbox(); });
test.afterEach(async () => { await inbox.close(); });

test('an answer to a card its agent revised afterwards says which version the person answered', async ({ page }) => {
  await inbox.agent.post({ id: 'size', agent: 's-size', title: 'Which size?', text: 'Pick the size that fits.', priority: 'now', options: [{ id: 'o1', label: 'Small' }, { id: 'o2', label: 'Large' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Which size?' }).click();
  await page.getByText('Large', { exact: true }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(async () => (await inbox.detail('size')).answer?.version).toBe(1);
  await inbox.agent.patch('size', [{ old: 'fits.', new: 'fits the box.' }]);
  await page.locator('.q', { hasText: 'Which size?' }).click();
  const note = page.locator('.note.ok', { hasText: 'Your answer' });
  await expect(note).toContainText('(to version 1, before the agent revised the card to version 2)');
  await expect(note).toContainText('Large');
  if (process.env['SHOT']) await page.screenshot({ path: process.env['SHOT'] });
});
