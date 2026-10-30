// An image pasted into a card's comment box shows as a thumbnail, can be removed, and arrives with the answer.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Paste a file into the field, as a browser does for Cmd+V on an image. */
async function pasteFile(page: Page, selector: string, type: string, name: string, body = PNG): Promise<void> {
  await page.locator(selector).first().evaluate((el, a) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(a.body), (c) => c.charCodeAt(0))], a.name, { type: a.type }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { type, name, body });
}

test('a pasted image shows a thumbnail, and two reach the agent with the answer', async ({ page }) => {
  await inbox.agent.post({ id: 'pi-1', agent: 's-pi-1', title: 'Paste an image', priority: 'now' });
  const ev = inbox.listen('s-pi-1');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Paste an image' }).click();
  await pasteFile(page, '.focus-card textarea', 'image/png', 'one.png');
  await pasteFile(page, '.focus-card textarea', 'image/png', 'two.png');
  await expect(page.locator('.focus-card .pasted-thumb img')).toHaveCount(2);
  await page.locator('.focus-card .pasted-remove').first().click();
  await expect(page.locator('.focus-card .pasted-thumb img')).toHaveCount(1);
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const a = ev.events.find((e) => e.type === 'answer');
  expect(a?.type === 'answer' && a.answer.images?.map((f) => f.name)).toEqual(['two.png']);
});

test('a file that is not an image is refused with a message', async ({ page }) => {
  await inbox.agent.post({ id: 'pi-2', agent: 's-pi-2', title: 'Paste a PDF', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Paste a PDF' }).click();
  await pasteFile(page, '.focus-card textarea', 'application/pdf', 'a.pdf', 'JVBERi0=');
  await expect(page.locator('.focus-card [role=alert]')).toContainText('PNG, JPEG, GIF or WebP');
  await expect(page.locator('.focus-card .pasted-thumb')).toHaveCount(0);
});
