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
