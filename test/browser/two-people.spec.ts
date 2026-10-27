// Two people on one inbox, in two browser contexts.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('an answer from one person moves the card for the other, live', async ({ browser }) => {
  await inbox.agent.post({ id: 'shared', agent: 's-two', title: 'Who takes this?', options: [{ id: 'me', label: 'I do' }], priority: 'now' });
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await inbox.open(alice);
  await inbox.open(bob);
  await expect(bob.locator('.card-title')).toHaveText('Who takes this?');
  await expect.poll(async () => (await (await fetch(`${inbox.server.url}/v1/person`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } })).json()).pages).toBe(2);
  await alice.getByText('I do', { exact: true }).click();
  await alice.getByRole('button', { name: 'Send answer' }).click();
  await expect(bob.locator('.queue')).toContainText('Outbox');
  await expect(bob.locator('.queue .q', { hasText: 'Who takes this?' })).toBeVisible();
  await expect.poll(async () => (await inbox.state()).states['shared']).toMatch(/answered|delivered/);
});

test('the person on screen is the one triage sees', async ({ browser }) => {
  await inbox.agent.post({ id: 'focus-me', agent: 's-two', title: 'Focus check', priority: 'now' });
  const page = await (await browser.newContext()).newPage();
  await inbox.open(page);
  await page.locator('.q', { hasText: 'Focus check' }).click();
  await expect.poll(async () => (await (await fetch(`${inbox.server.url}/v1/person`, { headers: { authorization: `Bearer ${inbox.server.ownerToken}` } })).json()).focus).toBe('focus-me');
});
