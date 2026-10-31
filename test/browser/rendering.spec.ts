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
  await expect(zip).toHaveAttribute('href', /\/v1\/attachments\/[^?]+$/);
});

test('an HTML attachment opens in a tab, even one an older agent posted as octet-stream', async ({ page }) => {
  await inbox.agent.post({ id: 'report', agent: 's-report', title: 'Read the report', priority: 'now', attachments: [
    { src: `data:application/octet-stream;base64,${b64('<h1>Friction report</h1>')}`, name: 'report.html' },
  ] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the report' }).click();
  const link = page.locator('a.file-name', { hasText: 'report.html' });
  await expect(link).not.toHaveAttribute('download', /.*/);
  const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await expect(tab.locator('h1')).toHaveText('Friction report');
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
    await expect(page.locator('.closed-line')).toContainText('Sent back to its agent');
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

test('a card says which agent it is from, and where it sits in herdr', async ({ page }) => {
  await inbox.agent.post({ id: 'placed', agent: 'claude:0000-placed', title: 'Placed card', from: 'the release agent',
    origin: { harness: 'claude-code', name: 'Release prep', herdrPane: 'w3:p2', herdrWorkspace: 'DevEx', herdrTab: 'login fix' } });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Placed card' }).click();
  await expect(page.locator('.focus-card .from')).toHaveText('From the release agent');
  await expect(page.locator('.focus-card .origin')).toContainText('Release prep · claude-code');
  await expect(page.locator('.focus-card .herdr-place')).toHaveText('herdr: workspace DevEx › tab login fix');
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

test('the tab icon is the ✋ emoji, with a red dot while a card waits for you', async ({ page }) => {
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

test('the queue clears answered and closed cards in one click, and keeps the waiting ones', async ({ page }) => {
  const own = await startInbox();
  try {
    await own.agent.post({ id: 'cl-wait', agent: 's-clear', title: 'Keep me waiting', priority: 'now' });
    await own.agent.post({ id: 'cl-gone', agent: 's-clear', title: 'Retract me', priority: 'later' });
    await own.agent.close('cl-gone', 'retracted', 'Not needed.');
    await own.open(page);
    const button = page.locator('button.clear-dealt');
    await expect(button).toHaveText('Clear 1 answered or closed card');
    await button.click();
    await expect(button).toHaveCount(0);
    await expect(page.locator('.q', { hasText: 'Retract me' })).toHaveCount(0);
    await expect(page.locator('.q', { hasText: 'Keep me waiting' })).toBeVisible();
  } finally { await own.close(); }
});

test('a broom in the Sent header clears answered and closed cards, without scrolling to the bottom', async ({ page }) => {
  const own = await startInbox();
  try {
    await own.agent.post({ id: 'br-wait', agent: 's-broom', title: 'Still waiting here', priority: 'now' });
    await own.agent.post({ id: 'br-gone', agent: 's-broom', title: 'Closed already', priority: 'later' });
    await own.agent.close('br-gone', 'retracted', 'Not needed.');
    await own.open(page);
    const broom = page.locator('.queue h3', { hasText: 'Sent, newest first' }).getByRole('button', { name: 'Clear 1 answered or closed card' });
    await expect(broom).toBeVisible();
    await broom.click();
    await expect(page.locator('.q', { hasText: 'Closed already' })).toHaveCount(0);
    await expect(page.locator('.q', { hasText: 'Still waiting here' })).toBeVisible();
    await expect(page.locator('.queue h3', { hasText: 'Sent, newest first' }).getByRole('button')).toHaveCount(0);
  } finally { await own.close(); }
});

test('a blocked agent card offers the dialog choices, and saves the one you pick', async ({ page }) => {
  const own = await startInbox();
  try {
    await own.agent.post({ id: 'blk', agent: 'herdr:w9:p1', kind: 'blocked', title: 'build is waiting for you', priority: 'now', text: 'Do you want to proceed?',
      options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No, and tell Claude what to do differently (esc)' }],
      screen: 'Bash command\n  npm run build\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)', origin: { harness: 'claude', herdrPane: 'w9:p1', name: 'build' } });
    await own.open(page);
    const frame = page.locator('.focus-card');
    await expect(frame.getByText('npm run build')).toBeVisible();
    await frame.getByText('No, and tell Claude what to do differently (esc)', { exact: true }).last().click();
    await frame.getByRole('button', { name: 'Press it in the session' }).click();
    await expect.poll(async () => (await own.state()).answers['blk']?.values['choice']).toBe('o2');
  } finally { await own.close(); }
});

test('the page takes its events over a WebSocket, and a new card shows without a reload', async ({ page }) => {
  const opened = page.waitForEvent('websocket', (ws) => /\/v1\/ws\?page=1/.test(ws.url()));
  await inbox.open(page);
  await opened;
  await inbox.agent.post({ id: 'live', agent: 's-live', title: 'Arrives over the page socket', priority: 'now' });
  await expect(page.getByText('Arrives over the page socket').first()).toBeVisible();
});

test('skip for now walks down the queue in its order, and wraps around at the end', async ({ page }) => {
  const own = await startInbox();
  try {
    for (const n of ['One', 'Two', 'Three', 'Four']) await own.agent.post({ id: `skip-${n}`, agent: `s-skip-${n}`, title: `Card ${n}`, priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
    await own.open(page);
    const queue = await page.locator('nav.queue button.q .t').allTextContents();
    const titles = queue.map((t) => /Card \w+/.exec(t)?.[0]).filter((t): t is string => !!t);
    expect(titles).toHaveLength(4);
    await page.locator('nav.queue button.q', { hasText: titles[0] }).click();
    const focused = () => page.locator('nav.queue button.q.focus .t');
    const visited: string[] = [];
    for (let i = 1; i <= 4; i++) {
      await page.getByRole('button', { name: 'Skip for now' }).click();
      await expect(focused()).toContainText(titles[i % 4]!);
      visited.push(titles[i % 4]!);
    }
    expect(visited).toEqual([titles[1], titles[2], titles[3], titles[0]]);
  } finally {
    await own.close();
  }
});

test('the recommendation stands out: a labeled callout at the card text size, above the options, on every kind of card', async ({ page }) => {
  await inbox.agent.post({ id: 'rec-plain', agent: 's-rec', title: 'Merge the fix?', priority: 'now', text: 'The stream ends early.',
    recommendation: 'Merge it.', options: [{ id: 'y', label: 'Merged' }] });
  await inbox.agent.post({ id: 'rec-html', agent: 's-rec', title: 'An HTML card with a recommendation', priority: 'now', html: '<p>Hi</p>', recommendation: 'Read it first.' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Merge the fix?' }).click();
  const rec = page.locator('.focus-card .recommendation');
  await expect(rec).toHaveText(/Recommendation\s*Merge it\./);
  const size = (l: import('@playwright/test').Locator) => l.evaluate((el) => getComputedStyle(el).fontSize);
  const weight = (l: import('@playwright/test').Locator) => l.evaluate((el) => Number(getComputedStyle(el).fontWeight));
  // The label is bold in the page's type, heavier than the text, and in the accent color.
  expect(await weight(rec.locator('.label'))).toBeGreaterThan(await weight(rec.locator('.markdown p')));
  expect(await rec.locator('.label').evaluate((el) => getComputedStyle(el).color)).not.toBe(await rec.locator('.markdown p').evaluate((el) => getComputedStyle(el).color));
  expect(await size(rec.locator('.markdown p'))).toBe(await size(page.locator('.focus-card .card-text p').first()));
  // A light marker: a line at its left and no fill, so it never looks like the selected card or a picked option.
  expect(await rec.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await rec.evaluate((el) => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).borderLeftStyle])).toEqual(['0px', 'solid']);
  // The page draws it once, above the options.
  await expect(page.locator('.focus-card').getByText('Recommendation: Merge it.')).toHaveCount(0);
  const recY = (await rec.boundingBox())!.y;
  expect(recY).toBeLessThan((await page.locator('.focus-card').getByText('Merged').first().boundingBox())!.y);
  await page.locator('.q', { hasText: 'An HTML card with a recommendation' }).click();
  await expect(page.locator('.focus-card .recommendation')).toHaveText(/Read it first\./);
});

test('a recommended option carries a Recommended tag and the recommendation inside its box, below its description', async ({ page }) => {
  await inbox.agent.post({ id: 'rec-flag', agent: 's-rec-opt', title: 'Merge the retry fix?', priority: 'now', text: 'CI is green.',
    recommendation: 'Tests pass, and the change is **small**.', options: [{ id: 'm', label: 'Merge', description: 'This agent merges the pull request.', recommended: true }, { id: 'w', label: 'Wait', description: 'This agent waits a day.' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Merge the retry fix?' }).click();
  const merge = page.locator('.focus-card .openui-option-card', { hasText: 'Merge' }).first();
  const wait = page.locator('.focus-card .openui-option-card', { hasText: 'Wait' }).first();
  // The recommendation moves inside the option it recommends, so the card says it once.
  await expect(page.locator('.focus-card .recommendation')).toHaveCount(0);
  await expect(merge.locator('.rec-tag')).toHaveText('Recommended');
  await expect(merge.locator('.rec-in-option .card-text strong')).toHaveText('small');
  await expect(wait.locator('.rec-tag')).toHaveCount(0);
  const below = (await merge.locator('.rec-in-option').boundingBox())!.y;
  expect(below).toBeGreaterThan((await merge.locator('.openui-option-card__subtitle').boundingBox())!.y);
  // The tag never looks like a pick: the box is not checked, and its fill and border match the other option's.
  await expect(merge).toHaveAttribute('aria-checked', 'false');
  const look = (l: import('@playwright/test').Locator) => l.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor]);
  expect(await look(merge)).toEqual(await look(wait));
  expect(await merge.locator('.rec-tag').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // The tag is heavier than the recommendation under it, as the Recommendation label is.
  const weight = (l: import('@playwright/test').Locator) => l.evaluate((el) => Number(getComputedStyle(el).fontWeight));
  expect(await weight(merge.locator('.rec-tag'))).toBeGreaterThan(await weight(merge.locator('.rec-in-option .card-text p').first()));
  // Picking it still works and looks as before.
  await merge.click();
  await expect(merge).toHaveAttribute('aria-checked', 'true');
});

test('an option the recommendation starts with is the recommended one, and the earlier-card fold still reads', async ({ page }) => {
  await inbox.agent.post({ id: 'rec-infer', agent: 's-rec-infer', title: 'Give PR CI a Datadog key?', priority: 'now',
    recommendation: 'Go ahead. A read-only key exposes nothing.', options: [{ id: 'g', label: 'Go ahead' }, { id: 'n', label: 'No Datadog key in PR CI' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Give PR CI a Datadog key?' }).click();
  const go = page.locator('.focus-card .openui-option-card', { hasText: 'Go ahead' }).first();
  await expect(page.locator('.focus-card .recommendation')).toHaveCount(0);
  await expect(go.locator('.rec-tag')).toHaveText('Recommended');
  // The box says the pick once: the recommendation drops the label it starts with.
  await expect(go.locator('.rec-in-option .card-text')).toHaveText('A read-only key exposes nothing.');
  await expect(page.locator('.focus-card .rec-tag')).toHaveCount(1);
  await go.click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await inbox.agent.post({ id: 'rec-infer-2', agent: 's-rec-infer', title: 'Which Datadog site?', priority: 'now', follows: 'rec-infer', text: 'The key is ready.' });
  await page.locator('.q', { hasText: 'Which Datadog site?' }).click();
  const earlier = page.locator('.focus-card details.earlier');
  await earlier.locator('summary').click();
  await expect(earlier.locator('.ans')).toContainText('Go ahead');
});

test('a recommendation that names no option keeps its own box, and no option gets the tag', async ({ page }) => {
  await inbox.agent.post({ id: 'rec-none', agent: 's-rec-none', title: 'Store sessions where?', priority: 'now',
    recommendation: 'SQLite, since the laptop build needs one file.', options: [{ id: 's', label: 'Use SQLite' }, { id: 'p', label: 'Use Postgres' }] });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Store sessions where?' }).click();
  await expect(page.locator('.focus-card .recommendation')).toHaveText(/Recommendation\s*SQLite, since/);
  await expect(page.locator('.focus-card .rec-tag')).toHaveCount(0);
});

test('an answer opens the card after the one you answered, not the card you skipped', async ({ page }) => {
  const own = await startInbox();
  try {
    for (const n of ['One', 'Two', 'Three']) await own.agent.post({ id: `ans-${n}`, agent: `s-ans-${n}`, title: `Card ${n}`, priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
    await own.open(page);
    const queue = await page.locator('nav.queue button.q .t').allTextContents();
    const titles = queue.map((t) => /Card \w+/.exec(t)?.[0]).filter((t): t is string => !!t);
    expect(titles).toHaveLength(3);
    const focused = () => page.locator('nav.queue button.q.focus .t');
    await page.locator('nav.queue button.q', { hasText: titles[0] }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(focused()).toContainText(titles[1]!);
    await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
    await expect(focused()).toContainText(titles[2]!);
  } finally {
    await own.close();
  }
});

test('a waiting card raises its hand in its level\'s color, and the person can change a level\'s color', async ({ page }) => {
  const own = await startInbox();
  try {
    for (const p of ['now', 'soon', 'later']) await own.agent.post({ id: `hand-${p}`, agent: `s-hand-${p}`, title: `Hand ${p}`, priority: p });
    await own.open(page);
    const hand = (p: string) => page.locator('nav.queue button.q', { hasText: `Hand ${p}` }).locator('.ico').evaluate((el) => getComputedStyle(el).color);
    expect(await hand('now')).toBe('rgb(229, 72, 77)');
    expect(await hand('soon')).toBe('rgb(201, 161, 0)');
    expect(['rgb(229, 72, 77)', 'rgb(201, 161, 0)']).not.toContain(await hand('later'));
    const levels = (await (await fetch(`${own.server.url}/v1/priorities`, { headers: { authorization: `Bearer ${own.server.ownerToken}` } })).json()) as { id: string }[];
    await fetch(`${own.server.url}/v1/priorities`, { method: 'PUT', headers: { authorization: `Bearer ${own.server.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(levels.map((l) => (l.id === 'later' ? { ...l, color: '#00aa00' } : l))) });
    await expect.poll(() => hand('later')).toBe('rgb(0, 170, 0)');
  } finally {
    await own.close();
  }
});

test('the line under a queue header is brighter than the panel border', async ({ page }) => {
  await inbox.open(page);
  const [line, panel] = await page.locator('nav.queue h3').first().evaluate((el) => [getComputedStyle(el).borderBottomColor, getComputedStyle(el.closest('nav')!).borderTopColor]);
  expect(line).not.toBe(panel);
});

test('a line under each queue header sets its section apart', async ({ page }) => {
  await inbox.agent.post({ id: 'header-line', agent: 's-line', title: 'Under a header', priority: 'now' });
  await inbox.open(page);
  const headers = page.locator('nav.queue h3');
  expect(await headers.count()).toBeGreaterThan(1);
  for (const border of await headers.evaluateAll((els) => els.map((el) => { const c = getComputedStyle(el); return `${c.borderBottomStyle} ${c.borderBottomWidth}`; }))) expect(border).toBe('solid 1px');
});

test('the queue headers use the text color, and the cards you sent are dimmer than the ones that wait', async ({ page }) => {
  await inbox.agent.post({ id: 'waits-dim', agent: 's-dim', title: 'Still waits', priority: 'now' });
  await inbox.agent.post({ id: 'sent-dim', agent: 's-dim', title: 'Already sent', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Already sent' }).click();
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  const color = (l: import('@playwright/test').Locator) => l.evaluate((el) => getComputedStyle(el).color);
  const ink = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--ink').trim());
  const muted = await page.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--muted)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  const inkRgb = await page.evaluate((v) => { const d = document.createElement('div'); d.style.color = v; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, ink);
  await page.locator('.focus-card').click();
  await expect.poll(() => color(page.locator('.queue h3', { hasText: 'Sent, newest first' }))).toBe(inkRgb);
  await expect.poll(() => color(page.locator('.q', { hasText: 'Already sent' }).locator('.t'))).toBe(muted);
  expect(await color(page.locator('.q', { hasText: 'Still waits' }).locator('.t'))).toBe(inkRgb);
});

test('a tall HTML card and a long attachment grow with the card, so the page is the only scroll', async ({ page }) => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const long = Array.from({ length: 80 }, (_, i) => `- line ${i + 1}`).join('\n');
  await inbox.agent.post({ id: 'tall', agent: 's-tall', title: 'A tall card', priority: 'now',
    html: '<div id=top>Top</div><div style="height:1500px"></div><div id=end>End</div>',
    attachments: [{ src: `data:text/markdown;base64,${b64(`# Notes\n\n${long}`)}`, name: 'notes.md' }] });
  await inbox.server.inbox.setSettings({ allowHtml: true });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A tall card' }).click();
  const show = page.getByRole('button', { name: 'Show this card' });
  if (await show.isVisible()) await show.click();
  const frame = page.locator('iframe.html-card');
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(1500);
  const inner = await page.frameLocator('iframe.html-card').locator('html').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(inner).toBeLessThanOrEqual(1);
  const md = page.locator('.file .markdown');
  await expect(md).toContainText('line 80');
  expect(await md.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
});

test('a short HTML card shrinks to its content and stays that height', async ({ page }) => {
  await inbox.server.inbox.setSettings({ allowHtml: true });
  await inbox.agent.post({ id: 'short-html', agent: 's-short', title: 'A short HTML card', priority: 'now', html: '<p style="margin:0;height:40px">One line</p>' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'A short HTML card' }).click();
  const frame = page.locator('iframe.html-card');
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeLessThan(80);
  const first = (await frame.boundingBox())?.height;
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(500);
  expect((await frame.boundingBox())?.height).toBe(first);
});

test('a card body reads in the dim text color, with its title and bold words in the bright one', async ({ page }) => {
  await inbox.agent.post({ id: 'dim-body', agent: 's-dim-body', title: 'Dim body', text: 'Plain words and **bold words**.', recommendation: 'Do the safe thing.', options: [{ id: 'o1', label: 'Go' }], priority: 'now',
    body: 'root = Card([head, t, tbl, f])\nhead = CardHeader("Ticket header", "Its subtitle")\nt = TextContent("Body text from OpenUI.")\ntbl = Table([Col("Ticket", ["T-1"])])\nf = Form("f", none, [fc])\nnone = Buttons([])\nfc = FormControl("Priority", RadioGroup("prio", [RadioItem("Urgent", "", "u"), RadioItem("Low", "", "l")]))' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Dim body' }).click();
  const color = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
  const token = (name: string) => page.evaluate((n) => { const d = document.createElement('div'); d.style.color = `var(${n})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, name);
  const [muted, ink] = [await token('--body-text'), await token('--ink')];
  expect(await color('.focus-card .card-text p')).toBe(muted);
  expect(await color('.focus-card .card-text strong')).toBe(ink);
  expect(await color('.focus-card .card-title')).toBe(ink);
  expect(await page.locator('.focus-card').getByText('Body text from OpenUI.').evaluate((el) => getComputedStyle(el).color)).toBe(muted);
  expect(await page.locator('.focus-card td').first().evaluate((el) => getComputedStyle(el).color)).toBe(muted);
  const textColor = (text: string) => page.locator('.focus-card').getByText(text, { exact: true }).first().evaluate((el) => getComputedStyle(el).color);
  expect(await textColor('Ticket header')).toBe(ink);
  expect(await textColor('Its subtitle')).toBe(muted);
  expect(await textColor('Priority')).toBe(ink);
  expect(await textColor('Urgent')).toBe(muted);
});

test('a card that waits for you shows a raised hand in the queue, and a sent one does not', async ({ page }) => {
  await inbox.agent.post({ id: 'hand-wait', agent: 's-hand', title: 'Raise a hand for me', priority: 'now' });
  await inbox.agent.post({ id: 'hand-sent', agent: 's-hand', title: 'Already answered hand', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Already answered hand' }).click();
  await page.locator('.focus-card button', { hasText: 'Send answer' }).click();
  const icon = (title: string) => page.locator('.q', { hasText: title }).locator('.ico');
  await expect(icon('Raise a hand for me')).toHaveAttribute('aria-label', 'to answer');
  expect(await icon('Raise a hand for me').locator('path').first().getAttribute('d')).toBe('M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2');
  await expect.poll(async () => icon('Already answered hand').locator('path').first().getAttribute('d')).not.toBe('M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2');
});

test('the selected card shows a filled hand, and the other waiting cards an outline', async ({ page }) => {
  await inbox.agent.post({ id: 'fill-a', agent: 's-fill', title: 'Filled hand one', priority: 'now' });
  await inbox.agent.post({ id: 'fill-b', agent: 's-fill', title: 'Filled hand two', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Filled hand one' }).click();
  const filled = (title: string) => page.locator('.q', { hasText: title }).locator('.ico path.fill').count();
  await expect.poll(() => filled('Filled hand one')).toBe(1);
  expect(await filled('Filled hand two')).toBe(0);
  await page.locator('.q', { hasText: 'Filled hand two' }).click();
  await expect.poll(() => filled('Filled hand two')).toBe(1);
  expect(await filled('Filled hand one')).toBe(0);
});

test('the card shows its rough age at the top right, and the age moves on with the clock', async ({ page }) => {
  await page.clock.install({ time: Date.now() });
  await inbox.agent.post({ id: 'aged', agent: 's-age', title: 'How old am I', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'How old am I' }).click();
  const age = page.locator('.focus-card .meta .age');
  await expect(age).toHaveText('just now');
  await page.clock.fastForward(15 * 60_000);
  await expect(age).toHaveText('15 min ago');
  await page.clock.fastForward(60 * 60_000);
  await expect(age).toHaveText('1 h 20 min ago');
  const [right, meta] = await Promise.all([age.evaluate((el) => el.getBoundingClientRect().right), page.locator('.focus-card .meta').evaluate((el) => el.getBoundingClientRect().right)]);
  expect(meta - right).toBeLessThan(2);
});

test('an agent reply draws its Markdown: bold, links and lists', async ({ page }) => {
  await inbox.agent.post({ id: 'reply-md', agent: 's-reply-md', title: 'Reply with Markdown', priority: 'now' });
  await inbox.agent.reply('reply-md', '**Deployed.** See [the run](https://example.com/run).\n\n- one\n- two');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Reply with Markdown' }).click();
  const reply = page.locator('.focus-card .reply-msg');
  await expect(reply.locator('strong', { hasText: 'Deployed.' })).toBeVisible();
  await expect(reply.locator('a[href="https://example.com/run"]')).toHaveText('the run');
  await expect(reply.locator('li')).toHaveCount(2);
  await expect(reply).not.toContainText('**');
});
