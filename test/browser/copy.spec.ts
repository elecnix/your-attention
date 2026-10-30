// Code on a card copies with a click: a block through its Copy button, inline code by a click on it.
// Each test reads the clipboard back from a second tab, so the tab under test may have no clipboard API at all.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const permit = (context: BrowserContext) => context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: inbox.server.url });
/** What the clipboard holds, read in another tab of the same browser. */
async function clipboard(context: BrowserContext): Promise<string> {
  const reader = await context.newPage();
  await reader.goto(`${inbox.server.url}/favicon.svg`);
  const text = await reader.evaluate(() => navigator.clipboard.readText());
  await reader.close();
  return text;
}
async function setClipboard(context: BrowserContext, text: string): Promise<void> {
  const writer = await context.newPage();
  await writer.goto(`${inbox.server.url}/favicon.svg`);
  await writer.evaluate((t) => navigator.clipboard.writeText(t), text);
  await writer.close();
}
async function openCard(page: Page, title: string): Promise<void> {
  await inbox.open(page);
  await page.locator('.q', { hasText: title }).click();
  await expect(page.locator('.card-title')).toHaveText(title);
}

test('a fenced block in the card text copies its exact text with its Copy button, and says Copied', async ({ page, context }) => {
  await permit(context);
  await inbox.agent.post({ id: 'fence', agent: 's-fence', title: 'Run the fence', text: 'Run:\n\n```sh\nnpm test\n  --watch\n```', priority: 'now' });
  await openCard(page, 'Run the fence');
  const copy = page.locator('.card-text .code-block').getByRole('button', { name: 'Copy', exact: true });
  await copy.click();
  await expect(page.locator('.card-text .code-block').getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await clipboard(context)).toBe('npm test\n  --watch');
  await expect(copy).toBeVisible({ timeout: 3000 });
});

test('the Copy button is reached with the keyboard and copies with Enter', async ({ page, context }) => {
  await permit(context);
  await inbox.agent.post({ id: 'keys', agent: 's-keys', title: 'Copy by keyboard', text: '```\nmake all\n```', priority: 'now' });
  await openCard(page, 'Copy by keyboard');
  const copy = page.locator('.card-text .code-block button');
  await copy.focus();
  await expect(copy).toBeFocused();
  await expect(copy).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(copy).toHaveAccessibleName('Copied');
  expect(await clipboard(context)).toBe('make all');
});

test('a CodeBlock and a fence in TextContent copy with the same Copy button', async ({ page, context }) => {
  await permit(context);
  await inbox.agent.post({ id: 'blocks', agent: 's-blocks', title: 'OpenUI blocks', priority: 'now',
    body: 'root = Card([c, t])\nc = CodeBlock("sh", "git push origin HEAD:main")\nt = TextContent("Then:\\n\\n```\\nnpm run deploy\\n```")' });
  await openCard(page, 'OpenUI blocks');
  const buttons = page.locator('.card-body').getByRole('button', { name: 'Copy', exact: true });
  await expect(buttons).toHaveCount(2);
  await buttons.first().click();
  await expect(page.locator('.card-body').getByRole('button', { name: 'Copied', exact: true })).toHaveCount(1);
  expect(await clipboard(context)).toBe('git push origin HEAD:main');
  await page.locator('.card-body').getByRole('button', { name: 'Copy', exact: true }).last().click();
  expect(await clipboard(context)).toBe('npm run deploy');
});

test('a drawn diagram has no Copy button, and its source view does', async ({ page, context }) => {
  await permit(context);
  const flow = 'flowchart TD\n  A --> B';
  await page.route('**/vendor/mermaid.min.js*', (r) => r.abort());
  await inbox.agent.post({ id: 'flow-copy', agent: 's-flow-copy', title: 'Diagram copy', text: `\`\`\`mermaid\n${flow}\n\`\`\``, priority: 'now' });
  await openCard(page, 'Diagram copy');
  await expect(page.locator('.card-text pre.diagram-source')).toBeVisible();
  await page.locator('.card-text').getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await clipboard(context)).toBe(flow);
  await page.unroute('**/vendor/mermaid.min.js*');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.card-text .diagram svg')).toHaveCount(1);
  await expect(page.locator('.card-text').getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
});

test('inline code copies on a click in the text, the recommendation, a reply, TextContent and a field label', async ({ page, context }) => {
  await permit(context);
  await inbox.agent.post({ id: 'inline', agent: 's-inline', title: 'Inline code', priority: 'now',
    text: 'Type `approve the merge` in my pane.', recommendation: 'Run `npm ci` first.',
    body: 'root = Card([t, f])\nt = TextContent("Or run `your-attention open`.")\nf = Form("f", none, [fc])\nnone = Buttons([])\nfc = FormControl("Name for `--branch`", Input("branch", "Branch"))' });
  await inbox.agent.reply('inline', 'Use `git fetch` then.');
  await openCard(page, 'Inline code');
  for (const [where, text] of [['.card-text', 'approve the merge'], ['.focus-card', 'npm ci'], ['.reply-msg', 'git fetch'], ['.card-body', 'your-attention open'], ['.card-body', '--branch']] as const) {
    const code = page.locator(where).locator('code', { hasText: text }).first();
    await code.hover();
    await expect(code).toHaveAttribute('title', 'Click to copy');
    await expect(code).toHaveCSS('cursor', 'pointer');
    await code.click();
    await expect(code).toHaveAttribute('data-copied', 'Copied');
    await expect(page.locator('.copy-toast[aria-live="polite"]')).toHaveText('Copied');
    expect(await clipboard(context)).toBe(text);
  }
});

test('inline code inside a link follows the link and copies nothing', async ({ page, context }) => {
  await permit(context);
  await inbox.agent.post({ id: 'linked-code', agent: 's-linked-code', title: 'Linked code', priority: 'now',
    body: 'root = Card([t])\nt = TextContent("See [`the spec`](https://example.com/spec).")' });
  await openCard(page, 'Linked code');
  await setClipboard(context, 'before');
  await page.route('https://example.com/**', (r) => r.fulfill({ body: 'spec' }));
  const popup = page.waitForEvent('popup');
  await page.locator('.card-body a code').click();
  expect((await popup).url()).toBe('https://example.com/spec');
  expect(await clipboard(context)).toBe('before');
});

test('without the clipboard API, as on a LAN address, a click still copies', async ({ page, context }) => {
  await permit(context);
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true }); });
  await inbox.agent.post({ id: 'insecure', agent: 's-insecure', title: 'No clipboard API', text: 'Type `ship it now` here.\n\n```\nline one\nline two\n```', priority: 'now' });
  await openCard(page, 'No clipboard API');
  expect(await page.evaluate(() => navigator.clipboard)).toBeUndefined();
  await page.locator('.card-text code', { hasText: 'ship it now' }).click();
  expect(await clipboard(context)).toBe('ship it now');
  await page.locator('.card-text .code-block button').click();
  await expect(page.locator('.card-text .code-block button')).toHaveAccessibleName('Copied');
  expect(await clipboard(context)).toBe('line one\nline two');
  // The fallback leaves the focus where it was.
  await expect(page.locator('.card-text .code-block button')).toBeFocused();
});
