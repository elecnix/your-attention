import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

const b64 = (s: string) => Buffer.from(s).toString('base64');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('attachments render by type: a gallery, Markdown, CSV, JSON, and a download', async ({ page }) => {
  await inbox.agent.post({ id: 'files', agent: 's-files', title: 'Review the files', priority: 'now', attachments: [
    { src: `data:image/png;base64,${png}`, name: 'a.png', alt: 'Layout A' },
    { src: `data:image/png;base64,${png}`, name: 'b.png', alt: 'Layout B' },
    { src: `data:text/markdown;base64,${b64('# Plan\n\n- **bridge** first')}`, name: 'plan.md' },
    { src: `data:text/csv;base64,${b64('name,score\nbridge,3')}`, name: 'scores.csv' },
    { src: `data:application/json;base64,${b64('{"ok":true}')}`, name: 'data.json' },
    { src: `data:application/zip;base64,${b64('PK')}`, name: 'logs.zip' },
  ] });
  await inbox.open(page);
  await expect(page.locator('.gallery img')).toHaveCount(2);
  await expect(page.locator('.markdown h3')).toHaveText('Plan');
  await expect(page.locator('.markdown strong')).toHaveText('bridge');
  await expect(page.locator('table.csv td').first()).toHaveText('bridge');
  await expect(page.locator('.file pre')).toContainText('"ok": true');
  const zip = page.locator('a.file-name', { hasText: 'logs.zip' });
  await expect(zip).toHaveAttribute('href', /download=1/);
});

test('card links show the linked title, and the linked card lists its backlinks', async ({ page }) => {
  await inbox.agent.post({ id: 'base', agent: 's-links', title: 'Pick the database', priority: 'later' });
  await inbox.agent.post({ id: 'linker', agent: 's-links', title: 'Plan the migration', text: 'This depends on [[base]].', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Plan the migration' }).click();
  await expect(page.locator('a.card-link')).toHaveText('Pick the database');
  await page.locator('a.card-link').click();
  await expect(page.locator('.card-title')).toHaveText('Pick the database');
  await expect(page.locator('.chain')).toContainText('Linked from Plan the migration');
});

test('a patched card shows what changed, and the agent label', async ({ page }) => {
  await inbox.agent.post({ id: 'spec', agent: 's-patch', title: 'Approve the spec', text: 'Use SQLite.', priority: 'now' });
  await inbox.agent.patch('spec', [{ old: 'SQLite', new: 'SQLite with FTS5' }]);
  await inbox.agent.status('spec', 'waiting on CI');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Approve the spec' }).click();
  await expect(page.locator('.status', { hasText: 'waiting on CI' })).toBeVisible();
  await page.locator('details.changes summary').click();
  await expect(page.locator('details.changes .add')).toContainText('SQLite with FTS5');
});

test('the queue groups by agent or by a tag when asked, and by nothing at first', async ({ page }) => {
  await inbox.agent.post({ id: 'g1', agent: 'agent-x', title: 'Grouped one', tags: { topic: 'release' } });
  await inbox.agent.post({ id: 'g2', agent: 'agent-y', title: 'Grouped two', tags: { topic: 'docs' } });
  await inbox.open(page);
  await expect(page.locator('.queue h3').first()).toHaveText('Waiting for you');
  await page.locator('.group-by select').selectOption('agent');
  await expect(page.locator('.queue h3', { hasText: 'agent-x' })).toBeVisible();
  await page.locator('.group-by select').selectOption('tag:topic');
  await expect(page.locator('.queue h3', { hasText: 'release' })).toBeVisible();
});

test('a card with its own body and options still has an answer form', async ({ page }) => {
  await inbox.agent.post({ id: 'tpl', agent: 's-tpl', title: 'Which port?', priority: 'now', body: 'root = Card([CardHeader("Port choice", "From a template")])', options: [{ id: 'o1', label: '8080' }, { id: 'o2', label: '9090' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Which port?' }).click();
  await expect(page.getByText('Port choice')).toBeVisible();
  await expect(page.getByText('9090', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send answer' })).toBeVisible();
});

test('"What changed" lists every edit, field by field', async ({ page }) => {
  await inbox.agent.post({ id: 'multi', agent: 's-multi', title: 'Edited often', text: 'one', recommendation: 'A', priority: 'now' });
  await inbox.agent.patch('multi', [{ old: 'one', new: 'two' }]);
  await inbox.agent.patch('multi', [{ old: 'A', new: 'B' }], 'recommendation');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Edited often' }).click();
  await page.locator('details.changes summary').click();
  await expect(page.locator('details.changes summary')).toContainText('2 edits');
  await expect(page.locator('details.changes .field')).toContainText(['Recommendation', 'Text']);
});

test('a PDF from the inbox shows in a frame without a sandbox', async ({ page }) => {
  await inbox.agent.post({ id: 'pdf', agent: 's-pdf', title: 'Read the PDF', priority: 'now', attachments: [{ src: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64')}`, name: 'doc.pdf' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the PDF' }).click();
  const frame = page.locator('iframe.pdf');
  await expect(frame).toBeVisible();
  expect(await frame.getAttribute('sandbox')).toBeNull();
});

test('the queue border drags or takes arrow keys to resize the queue, and the width stays after a reload', async ({ page }) => {
  await inbox.open(page);
  const queue = page.locator('.queue');
  const handle = page.getByRole('separator', { name: 'Resize the card list' });
  const before = (await queue.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 40, { steps: 5 });
  await page.mouse.up();
  const wider = (await queue.boundingBox())!.width;
  expect(Math.abs(wider - before - 120)).toBeLessThan(4);
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Math.round((await queue.boundingBox())!.width)).toBe(Math.round(wider - 16));
  await page.reload();
  await expect.poll(async () => Math.round((await queue.boundingBox())!.width)).toBe(Math.round(wider - 16));
});

test('text in the inbox and in its cards is Gill Sans, larger than the defaults, and code stays monospace', async ({ page }) => {
  await inbox.agent.post({ id: 'type', agent: 's-type', title: 'Typography', attachments: [{ src: `data:text/markdown;base64,${b64('Run `npm test` first.')}`, name: 'steps.md' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Typography' }).click();
  const font = (sel: string) => page.locator(sel).first().evaluate((el) => { const s = getComputedStyle(el); return { family: s.fontFamily, size: parseFloat(s.fontSize) }; });
  expect((await font('body')).size).toBe(18);
  expect((await font('.card-title')).family).toContain('Gill Sans');
  expect((await font('.focus-card code')).family).toContain('monospace');
  const header = await page.locator('.queue h3').first().evaluate((el) => Number(getComputedStyle(el).fontWeight));
  expect(header).toBeGreaterThanOrEqual(600);
});

test('the top bar links to the project on GitHub', async ({ page }) => {
  await inbox.open(page);
  const link = page.getByRole('link', { name: 'Your Attention on GitHub' });
  await expect(link).toHaveAttribute('href', 'https://github.com/elecnix/your-attention');
  await expect(link.locator('svg')).toBeVisible();
});

test('a queue width saved on a wider window shrinks to fit a narrower one', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('queueWidth', '2000'));
  await page.setViewportSize({ width: 1000, height: 800 });
  await inbox.open(page);
  expect((await page.locator('.queue').boundingBox())!.width).toBeLessThanOrEqual(640);
});

test('a card triage sent back shows its content on request', async ({ page }) => {
  const own = await startInbox();
  try {
    const ext = { token: 'tx', role: 'extension' as const };
    const calls: { id: string }[] = [];
    own.server.inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e as { id: string }));
    await own.agent.post({ id: 'back', agent: 's-back', title: 'Thoughts?', text: 'The body triage judged.' });
    own.server.inbox.hookVerdict(ext, calls[0]!.id, 'return', 'Say what you recommend.');
    await own.open(page);
    await page.locator('.q', { hasText: 'Thoughts?' }).click();
    await expect(page.locator('.closed-line')).toContainText('Sent back by triage');
    await page.getByRole('button', { name: 'Show card' }).click();
    await expect(page.getByText('The body triage judged.')).toBeVisible();
  } finally {
    await own.close();
  }
});

test('the browser back and forward buttons move between the cards you opened', async ({ page }) => {
  await inbox.agent.post({ id: 'nav-a', agent: 's-nav', title: 'First card to read', priority: 'now' });
  await inbox.agent.post({ id: 'nav-b', agent: 's-nav', title: 'Second card, linking back', text: 'See [[nav-a]].', priority: 'now' });
  await inbox.open(page);
  const title = page.locator('.focus-card .card-title');
  await page.locator('.q', { hasText: 'First card to read' }).click();
  await expect(title).toHaveText('First card to read');
  await page.locator('.chain a', { hasText: 'Second card, linking back' }).click();
  await expect(title).toHaveText('Second card, linking back');
  await page.goBack();
  await expect(title).toHaveText('First card to read');
  await page.goForward();
  await expect(title).toHaveText('Second card, linking back');
  await page.reload();
  await expect(title).toHaveText('Second card, linking back');
});

test('a malformed card id in the address opens the inbox as usual', async ({ page }) => {
  await page.goto(`${inbox.server.url}/#token=${inbox.server.ownerToken}&card=%`);
  await page.locator('.bar .pill.on').waitFor();
  await expect(page.locator('.queue')).toBeVisible();
});

test('a revision marks the words it changed, not only the lines', async ({ page }) => {
  await inbox.agent.post({ id: 'words', agent: 's-words', title: 'Pick the cache', text: 'Use Redis for the cache layer.', priority: 'now' });
  await inbox.agent.post({ id: 'words', agent: 's-words', title: 'Pick the cache', text: 'Use SQLite for the cache layer.', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Pick the cache' }).click();
  await page.locator('details.changes summary').click();
  await expect(page.locator('details.changes .del mark')).toHaveText(['Redis']);
  await expect(page.locator('details.changes .add mark')).toHaveText(['SQLite']);
});

test('the queue names an agent by its session name, and by its id when it has none', async ({ page }) => {
  await inbox.agent.post({ id: 'named', agent: 'claude:0000-named', title: 'From a named session', origin: { harness: 'claude-code', name: 'Release prep' } });
  await inbox.agent.post({ id: 'unnamed', agent: 'claude:0000-plain', title: 'From an unnamed session' });
  await inbox.open(page);
  await page.locator('.group-by select').selectOption('agent');
  await expect(page.locator('.queue h3', { hasText: 'Release prep' })).toBeVisible();
  await expect(page.locator('.queue h3', { hasText: 'claude:0000-plain' })).toBeVisible();
  await expect(page.locator('.queue h3', { hasText: 'claude:0000-named' })).toHaveCount(0);
});

test('a line rewritten from scratch shows as removed and added, with no words marked', async ({ page }) => {
  await inbox.agent.post({ id: 'rewrite', agent: 's-rewrite', title: 'Rewrite the plan', text: 'Ship it Friday.', priority: 'now' });
  await inbox.agent.post({ id: 'rewrite', agent: 's-rewrite', title: 'Rewrite the plan', text: 'Wait until QA signs off.', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Rewrite the plan' }).click();
  await page.locator('details.changes summary').click();
  await expect(page.locator('details.changes .del')).toHaveText('− Ship it Friday.');
  await expect(page.locator('details.changes .add')).toHaveText('+ Wait until QA signs off.');
  await expect(page.locator('details.changes mark')).toHaveCount(0);
});

test('Escape clears the card pane until you pick a card, and back brings the card again', async ({ page }) => {
  await inbox.agent.post({ id: 'esc-a', agent: 's-esc', title: 'Escape me', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Escape me' }).click();
  const title = page.locator('.focus-card .card-title');
  await expect(title).toHaveText('Escape me');
  await page.locator('.focus-card textarea').first().focus();
  await page.keyboard.press('Escape');
  await expect(title).toHaveText('Escape me');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(title).toHaveCount(0);
  await expect(page.locator('.focus-card.done')).toContainText('No card selected');
  await expect(page.locator('.q.focus')).toHaveCount(0);
  await inbox.agent.post({ id: 'esc-b', agent: 's-esc', title: 'Arrives while cleared', priority: 'now' });
  await expect(page.locator('.q', { hasText: 'Arrives while cleared' })).toBeVisible();
  await expect(title).toHaveCount(0);
  await page.goBack();
  await expect(title).toHaveText('Escape me');
  await page.locator('.q', { hasText: 'Arrives while cleared' }).click();
  await expect(title).toHaveText('Arrives while cleared');
});

test('opening the inbox selects a card waiting for you, never one you already sent', async ({ page }) => {
  const own = await startInbox();
  try {
    await own.agent.post({ id: 'sent-1', agent: 's-sent', title: 'Already answered' });
    await own.agent.post({ id: 'wait-1', agent: 's-sent', title: 'Still waiting' });
    await own.open(page);
    await page.locator('.q', { hasText: 'Already answered' }).click();
    await own.server.inbox.answer('sent-1', { comment: 'done' });
    await expect(page.locator('.queue')).toContainText('Outbox');
    await page.goto(`${own.server.url}/`);
    await expect(page.locator('.focus-card .card-title')).toHaveText('Still waiting');
  } finally {
    await own.close();
  }
});

test('a card shows each widget its body placed, filled with its own values', async ({ page }) => {
  await inbox.agent.saveWidget('pull-request', fs.readFileSync(path.join(import.meta.dirname, '../../examples/widgets/pull-request.openui'), 'utf8'));
  await inbox.agent.post({ id: 'prs', agent: 's-prs', title: 'Merge these two?', priority: 'now', options: [{ id: 'yes', label: 'Merge both' }], body: [
    'root = Card([a, b])',
    'a = widget pull-request {"title": "Add stop", "subtitle": "#12", "state": "CI green", "url": "https://github.com/elecnix/your-attention/pull/12"}',
    'b = widget pull-request {"title": "Name agents", "subtitle": "#13", "state": "CI running", "url": "https://github.com/elecnix/your-attention/pull/13"}',
  ].join('\n') });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Merge these two?' }).click();
  await expect(page.locator('.focus-card').getByText('Add stop')).toBeVisible();
  await expect(page.locator('.focus-card').getByText('CI running')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the pull request' })).toHaveCount(2);
  await expect(page.getByText('Merge both')).toBeVisible();
});

test('card text renders Markdown links, lists and bare addresses, and keeps its line breaks and card links', async ({ page }) => {
  await inbox.agent.post({ id: 'md-target', agent: 's-md', title: 'The earlier decision', priority: 'later' });
  await inbox.agent.post({ id: 'md-text', agent: 's-md', title: 'Merge order?', priority: 'now', text: [
    'Goal: merge **three** pull requests.',
    'Second line of the goal.',
    '',
    '1. [#12, fix the build](https://github.com/example/repo/pull/12). Ready.',
    '2. Ticket https://example.com/T-4, see [[md-target]].',
    '',
    'A [bad link](javascript:alert(1)) stays text.',
  ].join('\n') });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Merge order?' }).click();
  const text = page.locator('.card-text');
  await expect(text.locator('a[href="https://github.com/example/repo/pull/12"]')).toHaveText('#12, fix the build');
  await expect(text.locator('a[href="https://example.com/T-4"]')).toHaveText('https://example.com/T-4');
  await expect(text.locator('ol li')).toHaveCount(2);
  await expect(text.locator('strong')).toHaveText('three');
  await expect(text.locator('p').first()).toHaveText('Goal: merge three pull requests.\nSecond line of the goal.');
  await expect(text.locator('li a.card-link')).toHaveText('The earlier decision');
  await expect(text.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(text).toContainText('bad link');
});

test('the tab icon is the amber hand, with a red dot while a card waits for you', async ({ page }) => {
  const own = await startInbox();
  try {
    const icon = page.locator('link[rel="icon"]');
    await own.open(page);
    await expect(page.locator('.focus-card.done')).toBeVisible();
    await expect(icon).toHaveAttribute('href', 'favicon.svg');
    await own.agent.post({ id: 'icon-wait', agent: 's-icon', title: 'Pick a color?', priority: 'now' });
    await expect(icon).toHaveAttribute('href', 'favicon-waiting.svg');
    await own.agent.close('icon-wait', 'resolved', 'Picked it myself.');
    await expect(icon).toHaveAttribute('href', 'favicon.svg');
    for (const f of ['favicon.svg', 'favicon-waiting.svg']) {
      const res = await page.request.get(new URL(f, page.url()).href);
      expect(res.headers()['content-type']).toBe('image/svg+xml');
    }
  } finally { await own.close(); }
});
