// Group by and the pinned tag values are the inbox's settings, not this device's: a change on one page shows on every
// other page at once, and a page copies the values an older version kept on the device into an empty inbox once.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  await inbox.agent.post({ id: 'st-invoice', agent: 's-st', title: 'Ship the invoice fix?', priority: 'now', tags: { topic: 'billing', repo: 'acme/api' } });
  await inbox.agent.post({ id: 'st-search', agent: 's-st', title: 'Rebuild the search index?', priority: 'soon', tags: { topic: 'search' } });
});
test.afterAll(async () => { await inbox.close(); });

test('Group by on one page reaches another page open at the same time', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await inbox.open(alice);
  await inbox.open(bob);
  await alice.locator('.group-by select').selectOption('priority');
  await expect(bob.locator('.group-by select')).toHaveValue('priority');
  await expect(bob.locator('.queue h3', { hasText: 'Decide now' })).toBeVisible();
  expect(inbox.server.inbox.settings().groupBy).toBe('priority');
  // A change the owner makes elsewhere, such as in the terminal client, reaches both pages.
  inbox.server.inbox.setSettings({ groupBy: 'tag:topic' });
  for (const page of [alice, bob]) {
    await expect(page.locator('.group-by select')).toHaveValue('tag:topic');
    await expect(page.locator('.queue h3', { hasText: 'billing' })).toBeVisible();
  }
  inbox.server.inbox.setSettings({ groupBy: 'none' });
});

test('a pin on one page reaches the other page open at the same time', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await inbox.open(alice);
  await inbox.open(bob);
  await alice.locator('.group-by select').selectOption('tag:repo');
  await alice.locator('.queue h3', { hasText: 'acme/api' }).getByRole('button', { name: 'Pin repo: acme/api to the top' }).click();
  await expect(bob.locator('.queue h3').first()).toHaveText(/repo: acme\/api/);
  expect(inbox.server.inbox.settings().pins).toEqual([['repo', 'acme/api']]);
  await alice.locator('.queue h3', { hasText: 'repo: acme/api' }).getByRole('button', { name: 'Unpin repo: acme/api' }).click();
  await expect(bob.locator('.queue h3').first()).not.toHaveText(/repo: acme\/api/);
  expect(inbox.server.inbox.settings().pins).toEqual([]);
  inbox.server.inbox.setSettings({ groupBy: 'none' });
});

test('a page copies the values an older version kept on this device into an empty inbox, once', async ({ browser }) => {
  const own = await startInbox();
  try {
    await own.agent.post({ id: 'st-old', agent: 's-old', title: 'A card with a tag', priority: 'now', tags: { topic: 'billing' } });
    const first = await (await browser.newContext()).newPage();
    await first.addInitScript(() => {
      localStorage.setItem('groupBy', JSON.stringify('priority'));
      localStorage.setItem('tagPins', JSON.stringify([['topic', 'billing']]));
    });
    await own.open(first);
    await expect.poll(async () => own.server.inbox.settings()).toMatchObject({ groupBy: 'priority', pins: [['topic', 'billing']] });
    await expect(first.locator('.group-by select')).toHaveValue('priority');
    await expect(first.locator('.queue h3').first()).toHaveText(/topic: billing/);

    // A second device has values of its own, and copies nothing over the inbox's.
    const second = await (await browser.newContext()).newPage();
    await second.addInitScript(() => {
      localStorage.setItem('groupBy', JSON.stringify('agent'));
      localStorage.setItem('tagPins', JSON.stringify([['repo', 'other/repo']]));
    });
    await own.open(second);
    await expect(second.locator('.group-by select')).toHaveValue('priority');
    expect(own.server.inbox.settings()).toMatchObject({ groupBy: 'priority', pins: [['topic', 'billing']] });

    // After the copy, the inbox is the source of truth: a change there wins, and a reload copies nothing back.
    own.server.inbox.setSettings({ groupBy: 'agent' });
    await expect(first.locator('.group-by select')).toHaveValue('agent');
    await first.reload();
    await first.locator('.bar .pill.on').waitFor();
    await expect(first.locator('.group-by select')).toHaveValue('agent');
    expect(own.server.inbox.settings().groupBy).toBe('agent');
  } finally {
    await own.close();
  }
});
