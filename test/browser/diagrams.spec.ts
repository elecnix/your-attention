import { expect, test, type Page } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

// The shape of a real decision card: a table, then a flowchart with decisions and labelled edges.
const FLOW = [
  'flowchart TD',
  '  A[Caller sends DELETE] --> B{Has the scope?}',
  '  B -- no --> X[403]',
  '  B -- yes --> C{Gate mode}',
  '  C -- off --> P[Passes]',
  '  C -- enforce --> D{Staff token?}',
  '  D -- no --> X',
  '  D -- yes --> P',
].join('\n');
const TEXT = `## The gate\n\n| Mode | Effect |\n| --- | --- |\n| \`off\` | Every request passes. |\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n## The choice\n\nPick one.`;

const nodeFill = (page: Page) => page.locator('.card-text .diagram svg .node rect').first().evaluate((el) => getComputedStyle(el).fill);

for (const scheme of ['light', 'dark'] as const) {
  test(`a mermaid block in card text draws as a diagram in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await inbox.agent.post({ id: `flow-${scheme}`, agent: `s-flow-${scheme}`, title: `Gate flow ${scheme}`, text: TEXT, priority: 'now' });
    await inbox.open(page);
    await page.locator('.q', { hasText: `Gate flow ${scheme}` }).click();
    const svg = page.locator('.card-text .diagram svg');
    await expect(svg).toHaveCount(1);
    await expect(svg).toContainText('Caller sends DELETE');
    await expect(svg).toContainText('Staff token?');
    // The source never shows as text: no code block, and no "flowchart TD" anywhere on the card.
    await expect(page.locator('.card-text pre')).toHaveCount(0);
    await expect(page.locator('.focus-card, .card-text').first()).not.toContainText('flowchart TD');
    await expect(page.locator('.card-text table td').first()).toHaveText('off');
    // Nodes take the page's info colors: --info-bg is #e3eafb in light and #1c2645 in dark.
    expect(await nodeFill(page)).toBe(scheme === 'light' ? 'rgb(227, 234, 251)' : 'rgb(28, 38, 69)');
  });
}

test('a diagram draws again in the new colors when the theme changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await inbox.agent.post({ id: 'flow-switch', agent: 's-flow-switch', title: 'Theme switch', text: `\`\`\`mermaid\n${FLOW}\n\`\`\``, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Theme switch' }).click();
  await expect.poll(() => nodeFill(page)).toBe('rgb(227, 234, 251)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => nodeFill(page)).toBe('rgb(28, 38, 69)');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect.poll(() => nodeFill(page)).toBe('rgb(227, 234, 251)');
});

test('a diagram that could not draw shows its source, and draws once the renderer loads', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.route('**/vendor/mermaid.min.js*', (r) => r.abort());
  await inbox.agent.post({ id: 'flow-retry', agent: 's-flow-retry', title: 'Renderer retry', text: `\`\`\`mermaid\n${FLOW}\n\`\`\``, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Renderer retry' }).click();
  await expect(page.locator('.card-text pre.diagram-source')).toContainText('Caller sends DELETE');
  await page.unroute('**/vendor/mermaid.min.js*');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.card-text .diagram svg')).toHaveCount(1);
  await expect(page.locator('.card-text pre')).toHaveCount(0);
});

test('a Mermaid statement and the mermaid widget draw in a card body, with its string read as the inbox read it', async ({ page }) => {
  const body = [
    'root = Card([intro, seq, flow])',
    'intro = TextContent("Two diagrams.")',
    'seq = Mermaid("sequenceDiagram\\n  Agent->>Inbox: Caf\\u00e9 \\"order\\"\\n  Inbox-->>Agent: 201")',
    `flow = widget mermaid ${JSON.stringify({ source: 'flowchart LR\n  Post --> Check --> Show' })}`,
  ].join('\n');
  await inbox.agent.post({ id: 'body-diagrams', agent: 's-body', title: 'Body diagrams', body, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Body diagrams' }).click();
  await expect(page.locator('.diagram svg')).toHaveCount(2);
  await expect(page.locator('.diagram svg').first()).toContainText('Café "order"');
  await expect(page.locator('.diagram svg').nth(1)).toContainText('Check');
  await expect(page.getByText('sequenceDiagram')).toHaveCount(0);
});

test('the page reads a body\'s strings and comments as the inbox did', async ({ page }) => {
  const body = [
    'root = Card([t, d])',
    "t = TextContent('A 5\" screen.')",
    "d = Mermaid('flowchart LR\\n  A[\"it\\'s single\"] --> B')",
    '// e = Mermaid("never drawn")',
  ].join('\n');
  await inbox.agent.post({ id: 'quotes', agent: 's-quotes', title: 'Quoted diagram', body, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Quoted diagram' }).click();
  await expect(page.locator('.diagram svg')).toHaveCount(1);
  await expect(page.locator('.diagram svg')).toContainText("it's single");
});

test('the inbox refuses a diagram mermaid cannot parse, so the page never shows it', async ({ page }) => {
  await expect(inbox.agent.post({ id: 'bad-flow', agent: 's-bad', title: 'Broken diagram', text: '```mermaid\nflowchart TD\n  A -. text .->|label| B\n```', priority: 'now' }))
    .rejects.toThrow(/400 The Mermaid diagram in text, the diagram on line 1 does not parse/);
  await inbox.open(page);
  await expect(page.locator('.q', { hasText: 'Broken diagram' })).toHaveCount(0);
});
