import { expect, test } from '@playwright/test';
import { seal } from '../../web/sealed.js';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('the person picks an option, adds a comment, and the agent receives both at once', async ({ page }) => {
  const heard = inbox.listen('s-answer');
  await inbox.agent.post({ id: 'pick', agent: 's-answer', title: 'Which storage?', text: 'SQLite or Postgres.', recommendation: 'SQLite.', options: [{ id: 'o1', label: 'SQLite' }, { id: 'o2', label: 'Postgres' }], priority: 'now' });
  await inbox.open(page);
  await expect(page.locator('.card-title')).toHaveText('Which storage?');
  await expect(page.locator('.pill.small.on')).toHaveText('Agent listening');
  await page.getByText('SQLite', { exact: true }).click();
  await page.locator('textarea').fill('One file is enough.');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => heard.events.find((e) => e.type === 'answer')).toBeTruthy();
  const ev = heard.events.find((e) => e.type === 'answer');
  expect(ev?.type === 'answer' && ev.answer.values).toEqual({ choice: 'o1' });
  expect(ev?.type === 'answer' && ev.answer.comment).toBe('One file is enough.');
  await expect(page.locator('.queue')).toContainText('Outbox');
});

test('an empty answer is allowed', async ({ page }) => {
  await inbox.agent.post({ id: 'empty', agent: 's-empty', title: 'Anything to add?' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Anything to add?' }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(async () => (await inbox.state()).answers['empty']?.comment).toBe('');
});

test('a new card joins the queue while the card on screen stays put', async ({ page }) => {
  await inbox.agent.post({ id: 'first', agent: 's-live', title: 'The card I am reading', priority: 'soon' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'The card I am reading' }).click();
  await inbox.agent.post({ id: 'urgent', agent: 's-live', title: 'An urgent card arrives', priority: 'now' });
  await expect(page.locator('.q', { hasText: 'An urgent card arrives' })).toBeVisible();
  await expect(page.locator('.q', { hasText: 'An urgent card arrives' }).locator('.new')).toHaveText('new');
  await expect(page.locator('.card-title')).toHaveText('The card I am reading');
});

test('a card the agent closes while you read it collapses to its outcome', async ({ page }) => {
  await inbox.agent.post({ id: 'closing', agent: 's-close', title: 'Still needed?', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Still needed?' }).click();
  await inbox.agent.close('closing', 'self-answered', 'Found it in the README.');
  await expect(page.locator('.closed-line')).toContainText('Found it in the README.');
  await expect(page.locator('.closed-line .tag')).toHaveText('Answered by agent');
  await expect(page.locator('.collapse')).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Show card' }).click();
  await expect(page.locator('.collapse')).toHaveCSS('opacity', '1');
  await expect(page.locator('.collapse .card-title')).toHaveText('Still needed?');
  await page.getByRole('button', { name: 'Hide card' }).click();
  await expect(page.locator('.collapse')).toHaveCSS('opacity', '0');
});

test('a secret is sealed in the browser, and only the asking session opens it', async ({ page }) => {
  const secrets = new SecretRequests();
  const id = await secrets.ask(inbox.agent, { agent: 's-secret', name: 'DEMO_TOKEN', title: 'Need the demo token', priority: 'now' });
  const heard = inbox.listen('s-secret');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Need the demo token' }).click();
  await page.locator('input[type=password]').fill('typed-in-the-browser');
  await page.getByRole('button', { name: 'Send sealed' }).click();
  await expect.poll(() => heard.events.find((e) => e.type === 'answer')).toBeTruthy();
  const ev = heard.events.find((e) => e.type === 'answer');
  if (ev?.type !== 'answer') throw new Error('no answer');
  expect(JSON.stringify(ev.answer)).not.toContain('typed-in-the-browser');
  expect(await secrets.receive(ev.card, ev.answer)).toMatch(/It is in .*DEMO_TOKEN/);
  void id;
  void seal;
});

test('an HTML card stays hidden until the owner allows it, then answers from its sandbox', async ({ page }) => {
  await inbox.agent.post({ id: 'html', agent: 's-html', title: 'Pick a colour', html: "<button id=b onclick=\"yourAttention.answer({colour:'blue'},'from the frame')\">Blue</button>", priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Pick a colour' }).click();
  // The switch lives on the HTML card, not in the bar.
  await expect(page.getByLabel('Allow HTML cards')).toHaveCount(0);
  await expect(page.locator('.note.warn')).toContainText('own HTML and scripts');
  await expect(page.locator('.note.warn')).toContainText('can open a page in a new tab');
  await page.getByRole('button', { name: 'Always show HTML cards' }).click();
  expect(await page.locator('iframe.html-card').getAttribute('srcdoc')).toContain("default-src 'none'");
  const frame = page.frameLocator('iframe.html-card');
  await frame.locator('#b').click();
  await expect.poll(async () => (await inbox.state()).answers['html']?.values).toEqual({ colour: 'blue' });
});

test('a link in an HTML card opens in a new tab', async ({ page, context }) => {
  await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Linked page</title>' }));
  await inbox.agent.post({ id: 'html-link', agent: 's-html-link', title: 'Read the linked page', html: '<a id=l href="https://example.com/pr/12">Pull request 12</a>', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Read the linked page' }).click();
  // An earlier test may have turned HTML cards on for the whole inbox.
  const show = page.getByRole('button', { name: 'Show this card' });
  if (await show.isVisible()) await show.click();
  const opened = context.waitForEvent('page');
  await page.frameLocator('iframe.html-card').locator('#l').click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toBe('https://example.com/pr/12');
  expect(await tab.evaluate(() => window.opener)).toBeNull();
});

test('an HTML card shows once on request, and the owner can stop showing them from the card', async ({ page }) => {
  await inbox.server.inbox.setSettings({ allowHtml: false });
  await inbox.agent.post({ id: 'html-once', agent: 's-html-once', title: 'Pick a shape', html: '<p id=p>Square</p>', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Pick a shape' }).click();
  await page.getByRole('button', { name: 'Show this card' }).click();
  await expect(page.frameLocator('iframe.html-card').locator('#p')).toHaveText('Square');
  expect((await inbox.state() as unknown as { settings: { allowHtml: boolean } }).settings.allowHtml).toBe(false);
  await page.getByRole('button', { name: 'Always show HTML cards' }).click();
  await expect.poll(async () => (await inbox.state() as unknown as { settings: { allowHtml: boolean } }).settings.allowHtml).toBe(true);
  await page.getByRole('button', { name: 'Stop showing HTML cards' }).click();
  await expect(page.locator('.note.warn')).toContainText('own HTML and scripts');
});

test('an HTML card ends with the page comment box: Send answer collects the frame form, and the frame button keeps the comment', async ({ page }) => {
  await inbox.server.inbox.setSettings({ allowHtml: true });
  const html = '<label><input type=radio name=size value=small> Small</label><label><input type=radio name=size value=large> Large</label>'
    + '<label><input type=checkbox name=extras value=tests> Tests</label><input name=ticket>'
    + "<button id=own onclick=\"yourAttention.answer({size:'small'},'')\">Send from the card</button>";
  await inbox.agent.post({ id: 'html-footer', agent: 's-html-footer', title: 'Footer on an HTML card', html, priority: 'now' });
  await inbox.agent.post({ id: 'html-footer-2', agent: 's-html-footer', title: 'Second HTML card', html, priority: 'now' });
  const heard = inbox.listen('s-html-footer');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Footer on an HTML card' }).click();
  const frame = page.frameLocator('iframe.html-card');
  await frame.locator('input[value=large]').check();
  await frame.locator('input[value=tests]').check();
  await frame.locator('input[name=ticket]').fill('T-9');
  await page.locator('.html-answer textarea').fill('Large, with tests.');
  await page.locator('.html-answer').getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => heard.events.filter((e) => e.type === 'answer').length).toBe(1);
  const first = heard.events.find((e) => e.type === 'answer');
  expect(first?.type === 'answer' && [first.answer.values, first.answer.comment]).toEqual([{ size: 'large', extras: ['tests'], ticket: 'T-9' }, 'Large, with tests.']);
  await page.locator('.q', { hasText: 'Second HTML card' }).click();
  await page.locator('.html-answer textarea').fill('Sent from inside.');
  await page.frameLocator('iframe.html-card').locator('#own').click();
  await expect.poll(() => heard.events.filter((e) => e.type === 'answer').length).toBe(2);
  const second = heard.events.filter((e) => e.type === 'answer')[1];
  expect(second?.type === 'answer' && [second.answer.values, second.answer.comment]).toEqual([{ size: 'small' }, 'Sent from inside.']);
});

test('a revision of the HTML card you are commenting on keeps your comment and its focus', async ({ page }) => {
  await inbox.server.inbox.setSettings({ allowHtml: true });
  await inbox.agent.post({ id: 'html-rev', agent: 's-html-rev', title: 'Revised HTML card', html: '<p>First version</p>', priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Revised HTML card' }).click();
  const box = page.locator('.html-answer textarea');
  await box.click();
  await page.keyboard.type('half of my');
  await inbox.agent.post({ id: 'html-rev', agent: 's-html-rev', title: 'Revised HTML card', html: '<p>Second version</p>', priority: 'now' });
  await expect(page.frameLocator('iframe.html-card').locator('p')).toHaveText('Second version');
  await page.keyboard.type(' comment');
  await expect(box).toHaveValue('half of my comment');
});

test('an HTML card takes the app font, text size and weights, whatever its own styles say', async ({ page }) => {
  await inbox.server.inbox.setSettings({ allowHtml: true });
  const html = '<style>body{font:12px Arial;color:#ff0000}.why{font-size:10px}b{font-weight:900}</style>'
    + '<p id=p>Plain <b id=b>bold</b></p><div class=why id=why>Small print</div><code id=code>npm test</code>';
  await inbox.agent.post({ id: 'html-theme', agent: 's-html-theme', title: 'Styled by its agent', html, priority: 'now' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Styled by its agent' }).click();
  const app = await page.locator('.focus-card .card-title').evaluate(() => {
    const s = getComputedStyle(document.body);
    const muted = document.createElement('div');
    muted.style.color = 'var(--body-text)';
    document.body.append(muted);
    const color = getComputedStyle(muted).color;
    muted.remove();
    return { family: s.fontFamily, size: s.fontSize, color, ink: s.color };
  });
  const frame = page.frameLocator('iframe.html-card');
  const style = (sel: string) => frame.locator(sel).evaluate((el) => { const s = getComputedStyle(el); return { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, color: s.color }; });
  const p = await style('#p');
  expect(p.family).toBe(app.family);
  expect(p.size).toBe(app.size);
  expect(p.color).toBe(app.color);
  expect((await style('#why')).size).toBe(app.size);
  expect(Number((await style('#b')).weight)).toBeLessThanOrEqual(400);
  expect((await style('#b')).color).toBe(app.ink);
  expect((await style('#code')).family).toMatch(/monospace/);
});

test('Command or Control with Enter in the comment box sends the answer, and Shift with Enter adds a line', async ({ page }) => {
  await inbox.agent.post({ id: 'enter-send', agent: 's-enter', title: 'Send with the keyboard', priority: 'now' });
  const ev = inbox.listen('s-enter');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Send with the keyboard' }).click();
  const box = page.locator('.focus-card textarea').last();
  await box.fill('first line');
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  expect(ev.events.find((e) => e.type === 'answer')).toBeUndefined();
  await box.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const a = ev.events.find((e) => e.type === 'answer');
  expect(a?.type === 'answer' && a.answer.comment).toBe('first line\nsecond line');
});

test('an option shows its explanation inside its box, and a click on the explanation picks it', async ({ page }) => {
  await inbox.agent.post({ id: 'opt-detail', agent: 's-opt', title: 'Close both?', priority: 'now',
    options: [{ id: 'o1', label: 'Close both', description: 'I close **#2671** and cancel the ticket.' }, { id: 'o2', label: 'Keep #2671', description: 'It stays a draft.' }] });
  const ev = inbox.listen('s-opt');
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Close both?' }).click();
  const box = page.locator('.focus-card .openui-option-card', { hasText: 'Close both' });
  await expect(box.locator('strong', { hasText: '#2671' })).toBeVisible();
  await box.getByText('cancel the ticket', { exact: false }).click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await page.locator('.focus-card').getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => ev.events.find((e) => e.type === 'answer')?.type).toBe('answer');
  const a = ev.events.find((e) => e.type === 'answer');
  expect(a?.type === 'answer' && a.answer.values['choice']).toBe('o1');
});

test('a secret request reads its text as Markdown, as every other card does', async ({ page }) => {
  const secrets = new SecretRequests();
  await secrets.ask(inbox.agent, { agent: 's-secret-md', name: 'API_KEY', title: 'Paste the key', priority: 'now',
    text: 'Use the **production** key.\n\nWith it, I will:\n1. Create the secret.\n2. Set `KEY_ARN`.' });
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Paste the key' }).click();
  const card = page.locator('.focus-card');
  await expect(card.locator('strong', { hasText: 'production' })).toBeVisible();
  await expect(card.locator('ol li')).toHaveCount(2);
  await expect(card.locator('code', { hasText: 'KEY_ARN' })).toBeVisible();
  await expect(card.locator('h2', { hasText: 'Paste the key' })).toHaveCount(1);
});
