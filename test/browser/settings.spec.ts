// Group by and the pinned tag values are the inbox's settings, not this device's: a change on one page shows on every
// other page at once, and a page copies the values an older version kept on the device into an empty inbox once.
import { expect, test, type APIResponse, type Page, type Route } from '@playwright/test';
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

/** Keep back each GET /v1/state of the page from here on. The answer is fetched from the inbox at once, so each one
 * holds the state as it was when the page asked, and the test releases them in the order it chooses. */
async function holdStates(page: Page) {
  const kept: { route: Route; response?: APIResponse }[] = [];
  await page.route((url) => url.pathname === '/v1/state', async (route) => {
    const slot: { route: Route; response?: APIResponse } = { route };
    kept.push(slot);
    slot.response = await route.fetch();
  });
  const release = async (slot: { route: Route; response?: APIResponse } | undefined) => {
    if (!slot) return;
    await expect.poll(() => slot.response !== undefined).toBe(true);
    await slot.route.fulfill({ response: slot.response! });
  };
  return {
    /** How many states the inbox has built for the page and the test keeps back. */
    fetched: () => kept.filter((k) => k.response).length,
    releaseOldest: () => release(kept.shift()),
    releaseNewest: () => release(kept.pop()),
    releaseAll: async () => {
      await page.unroute((url) => url.pathname === '/v1/state');
      for (const k of kept.splice(0)) await release(k);
    },
  };
}
/** Let the page handle what it just received. */
const settle = (page: Page) => page.waitForTimeout(300);

test('a state requested before a Group by change and answered after it leaves the new choice on screen', async ({ page }) => {
  inbox.server.inbox.setSettings({ groupBy: 'none', pins: [] });
  await inbox.open(page);
  const states = await holdStates(page);
  try {
    // A new card makes the page ask for a state, which the inbox builds now, with Group by still at nothing.
    await inbox.agent.post({ id: 'st-late-group', agent: 's-st', title: 'Posted before the Group by change', priority: 'now' });
    await expect.poll(() => states.fetched()).toBeGreaterThan(0);
    await page.locator('.group-by select').selectOption('priority');
    await expect.poll(() => inbox.server.inbox.settings().groupBy).toBe('priority');
    // The state built before the change arrives after it. The page shows its card, and keeps the new grouping.
    await states.releaseOldest();
    await expect(page.locator('.queue').getByText('Posted before the Group by change')).toBeVisible();
    await settle(page);
    await expect(page.locator('.group-by select')).toHaveValue('priority');
    await states.releaseAll();
    await settle(page);
    await expect(page.locator('.group-by select')).toHaveValue('priority');
  } finally {
    await states.releaseAll();
    await inbox.agent.close('st-late-group', 'retracted', 'test over');
    inbox.server.inbox.setSettings({ groupBy: 'none' });
  }
});

test('a state requested before a pin and answered after it leaves the pin on screen', async ({ page }) => {
  inbox.server.inbox.setSettings({ groupBy: 'tag:topic', pins: [] });
  await inbox.open(page);
  const states = await holdStates(page);
  try {
    await inbox.agent.post({ id: 'st-late-pin', agent: 's-st', title: 'Posted before the pin', priority: 'now' });
    await expect.poll(() => states.fetched()).toBeGreaterThan(0);
    await page.locator('.queue h3', { hasText: 'billing' }).getByRole('button', { name: 'Pin topic: billing to the top' }).click();
    await expect.poll(() => inbox.server.inbox.settings().pins).toEqual([['topic', 'billing']]);
    await states.releaseOldest();
    await expect(page.locator('.queue').getByText('Posted before the pin')).toBeVisible();
    await settle(page);
    await expect(page.locator('.queue h3').first()).toHaveText(/topic: billing/);
  } finally {
    await states.releaseAll();
    await inbox.agent.close('st-late-pin', 'retracted', 'test over');
    inbox.server.inbox.setSettings({ groupBy: 'none', pins: [] });
  }
});

test('the page sends its Group by changes to the inbox one at a time, so the inbox keeps the last one', async ({ page }) => {
  inbox.server.inbox.setSettings({ groupBy: 'none', pins: [] });
  await inbox.open(page);
  // Each PUT /v1/settings waits here. A page that sends two at once has both kept, and they reach the inbox newest first.
  const writes: Route[] = [];
  await page.route((url) => url.pathname === '/v1/settings', (route) => {
    if (route.request().method() === 'PUT') writes.push(route); else void route.continue();
  });
  try {
    await page.locator('.group-by select').selectOption('priority');
    await page.locator('.group-by select').selectOption('agent');
    await settle(page);
    await expect.poll(async () => {
      await writes.pop()?.continue();
      return writes.length === 0 && inbox.server.inbox.settings().groupBy === 'agent';
    }).toBe(true);
    await settle(page);
    expect(inbox.server.inbox.settings().groupBy).toBe('agent');
    await expect(page.locator('.group-by select')).toHaveValue('agent');
  } finally {
    await page.unroute((url) => url.pathname === '/v1/settings');
    for (const r of writes.splice(0)) await r.continue();
    inbox.server.inbox.setSettings({ groupBy: 'none' });
  }
});

test('a state the page asked for before a newer one, and received after it, does not replace the newer cards', async ({ page }) => {
  inbox.server.inbox.setSettings({ groupBy: 'none', pins: [] });
  await inbox.open(page);
  const states = await holdStates(page);
  try {
    await inbox.agent.post({ id: 'st-order-a', agent: 's-st', title: 'The first of two new cards', priority: 'now' });
    await expect.poll(() => states.fetched()).toBeGreaterThan(0);
    const before = states.fetched();
    await inbox.agent.post({ id: 'st-order-b', agent: 's-st', title: 'The second of two new cards', priority: 'now' });
    await expect.poll(() => states.fetched()).toBeGreaterThan(before);
    await states.releaseNewest();
    await expect(page.locator('.queue').getByText('The second of two new cards')).toBeVisible();
    // The oldest state was built before the second card.
    await states.releaseOldest();
    await settle(page);
    await expect(page.locator('.queue').getByText('The second of two new cards')).toBeVisible();
  } finally {
    await states.releaseAll();
    for (const id of ['st-order-a', 'st-order-b']) await inbox.agent.close(id, 'retracted', 'test over');
  }
});
