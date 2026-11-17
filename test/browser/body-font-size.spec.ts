// A card's body draws its paragraphs, list items and form labels at the size of a card's plain text, in both color schemes.
import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  await inbox.agent.post({ id: 'plain', agent: 's-size', title: 'Plain text card', text: 'Pick the database for the cache.', priority: 'now' });
  await inbox.agent.post({ id: 'rich', agent: 's-size', title: 'Body card', priority: 'now', body: `root = Card([intro, form])
intro = TextContent("Pick the database for the cache.\\n\\n- SQLite on disk")
form = Form("db", none, [ctl])
none = Buttons([])
ctl = FormControl("Which database?", radio)
radio = RadioGroup("db", [RadioItem("SQLite", "", "sqlite"), RadioItem("Redis", "", "redis")])` });
});
test.afterAll(async () => { await inbox.close(); });

const fontSize = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontSize);

for (const scheme of ['dark', 'light'] as const) {
  test(`body text and plain text compute the same font size in the ${scheme} scheme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await inbox.open(page);
    await page.locator('.q', { hasText: 'Plain text card' }).click();
    const plain = await fontSize(page, '.focus-card .card-text');
    await page.locator('.q', { hasText: 'Body card' }).click();
    await expect(page.locator('.focus-card .openui-text-content-markdown p')).toBeVisible();
    expect(await fontSize(page, '.focus-card .openui-text-content-markdown p')).toBe(plain);
    expect(await fontSize(page, '.focus-card .openui-text-content-markdown li')).toBe(plain);
    expect(await fontSize(page, '.focus-card .openui-label')).toBe(plain);
    expect(await fontSize(page, '.focus-card .openui-radio-item-label')).toBe(plain);
  });
}
