// A comment pasted into a card arrives with the answer, however the person answers.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

for (const variant of ['send at once', 'pick then send', 'update then send', 'pick first, paste, send']) {
  test(`pasted comment arrives: ${variant}`, async ({ page }) => {
    const id = `p-${variant.replace(/\W+/g, '-')}`;
    await inbox.agent.post({ id, agent: `s-${id}`, title: `Paste ${variant}`, options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }], priority: 'now' });
    const ev = inbox.listen(`s-${id}`);
    await inbox.open(page);
    await page.locator('.q', { hasText: `Paste ${variant}` }).click();
    if (variant === 'pick first, paste, send') await page.locator('.focus-card').getByText('Yes', { exact: true }).click();
    await page.evaluate(() => navigator.clipboard.writeText('pasted words'));
    await page.locator('.focus-card textarea').click();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(page.locator('.focus-card textarea')).toHaveValue('pasted words');
    if (variant === 'pick then send') await page.locator('.focus-card').getByText('No', { exact: true }).click();
    if (variant === 'update then send') { await inbox.agent.post({ id: `${id}-x`, agent: 's-x', title: 'noise', priority: 'now' }); await page.waitForTimeout(300); }
    await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
    await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
    const a = ev.events.find((e) => e.type === 'answer');
    expect(a?.type === 'answer' && a.answer.comment).toBe('pasted words');
  });
}
