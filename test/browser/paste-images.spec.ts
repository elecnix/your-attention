// An image pasted into a card's comment box shows as a thumbnail, can be removed, and arrives with the answer.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** A file the person pastes or drags: anything with a base64 body, such as a PDF, is refused unless it is an image. */
type Dropped = { type: string; name: string; body?: string };
type Field = ReturnType<Page['locator']>;

/** Post a card, open it, and give back the panel that holds its answer field. */
async function openCard(page: Page, id: string, title: string): Promise<Field> {
  await inbox.agent.post({ id, agent: `s-${id}`, title, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: title }).click();
  return page.locator('.focus-card');
}

/** Put files on a field the way a browser does: a paste from Cmd+V, or a drop when the person drags from a window. */
async function putFiles(page: Page, selector: string, files: Dropped[], how: 'paste' | 'drop' = 'paste'): Promise<void> {
  await page.locator(selector).first().evaluate((el, a) => {
    const data = new DataTransfer();
    for (const f of a.files) data.items.add(new File([Uint8Array.from(atob(f.body), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const types = a.how === 'paste' ? ['paste'] : ['dragenter', 'dragover', 'drop'];
    for (const type of types) {
      el.dispatchEvent(type === 'paste'
        ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
        : new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  }, { files: files.map((f) => ({ ...f, body: f.body ?? PNG })), how });
}

/** Send the answer, and give back the names the agent received with it. */
async function sendAnswer(card: Field, listening: ReturnType<TestInbox['listen']>): Promise<string[] | undefined> {
  await card.locator('button', { hasText: 'Send answer' }).click();
  await expect.poll(() => listening.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const answer = listening.events.find((e) => e.type === 'answer');
  return answer?.type === 'answer' ? answer.answer.images?.map((f) => f.name) : undefined;
}

test('a pasted image shows a thumbnail, and two reach the agent with the answer', async ({ page }) => {
  const listening = inbox.listen('s-pi-1');
  const card = await openCard(page, 'pi-1', 'Paste an image');
  await putFiles(page, '.focus-card textarea', [{ type: 'image/png', name: 'one.png' }, { type: 'image/png', name: 'two.png' }]);
  await expect(card.locator('.pasted-thumb img')).toHaveCount(2);
  await card.locator('.pasted-remove').first().click();
  await expect(card.locator('.pasted-thumb img')).toHaveCount(1);
  expect(await sendAnswer(card, listening)).toEqual(['two.png']);
});

test('an image dropped on a comment box shows a thumbnail and reaches the agent with the answer', async ({ page }) => {
  const listening = inbox.listen('s-pi-3');
  const card = await openCard(page, 'pi-3', 'Drop an image');
  await putFiles(page, '.focus-card textarea', [{ type: 'image/png', name: 'dropped.png' }, { type: 'image/gif', name: 'moving.gif' }], 'drop');
  await expect(card.locator('.pasted-thumb img')).toHaveCount(2);
  expect(await sendAnswer(card, listening)).toEqual(['dropped.png', 'moving.gif']);
});

for (const how of ['paste', 'drop'] as const) {
  test(`a ${how === 'paste' ? 'pasted' : 'dropped'} file that is not an image is refused with a message`, async ({ page }) => {
    const card = await openCard(page, `pi-${how}`, how === 'paste' ? 'Paste a PDF' : 'Drop a PDF');
    await putFiles(page, '.focus-card textarea', [{ type: 'application/pdf', name: 'a.pdf', body: 'JVBERi0=' }], how);
    await expect(card.locator('[role=alert]')).toContainText('PNG, JPEG, GIF or WebP');
    await expect(card.locator('.pasted-thumb')).toHaveCount(0);
  });
}

test('clicking a thumbnail opens the full image in a new tab, before and after sending', async ({ page }) => {
  const card = await openCard(page, 'pi-5', 'Open an image');
  await putFiles(page, '.focus-card textarea', [{ type: 'image/png', name: 'big.png' }]);
  const draft = page.waitForEvent('popup');
  await card.locator('.pasted-thumb a').click();
  const tab = await draft;
  await expect.poll(() => tab.evaluate(() => document.images[0]?.naturalWidth ?? 0)).toBeGreaterThan(0);
  await tab.close();
  await card.locator('button', { hasText: 'Send answer' }).click();
  const sent = card.locator('.gallery a[target=_blank]');
  await expect(sent).toHaveCount(1);
  const answered = page.waitForEvent('popup');
  await sent.click();
  expect((await answered).url()).toContain('/v1/attachments/pi-5.a0.');
});
