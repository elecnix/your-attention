// The secret_access field on the whole page, on the stand-in inbox of the built stories: what Send answer posts for each
// field, the ceiling the person picks, a typed value sealed to the card's key, keyboard-only use, and Revoke.
// Run `npm run storybook:build` first.
import { expect, test, type Page } from '@playwright/test';
import { openSealed } from '../../src/core/sealed.ts';
import type { Sealed } from '../../src/core/types.ts';
import { serveStories } from './stories-server.ts';
import { TEST_PRIVATE_KEY } from './test-private-key.ts';

let storybook: Awaited<ReturnType<typeof serveStories>> | undefined;
let base = '';

test.beforeAll(async () => {
  storybook = await serveStories();
  base = storybook.base;
});
test.afterAll(() => { storybook?.close(); });

const story = (page: Page, id: string) => page.goto(`${base}/iframe.html?id=${id}&viewMode=story`);
/** The page story, with its one card open. */
async function openCard(page: Page): Promise<void> {
  await story(page, 'page--secret-access-card');
  await page.locator('.q', { hasText: 'Two secrets for the deploy' }).click();
}

/** The values of the answer the page posted, after Send answer. */
async function posted(page: Page): Promise<Record<string, unknown>> {
  await expect.poll(() => page.evaluate(() => ((window as unknown as { __posted?: { path: string }[] }).__posted ?? []).some((p) => p.path.endsWith('/answer')))).toBe(true);
  const all = await page.evaluate(() => (window as unknown as { __posted: { path: string; body: { values: Record<string, unknown> } }[] }).__posted);
  return all.find((p) => p.path.endsWith('/answer'))!.body.values;
}

const field = (page: Page, name: string) => page.locator('fieldset.secret-access', { has: page.locator('legend', { hasText: `Who may read ${name}` }) });

test('a grant posts the picked candidate, and the ceiling the person sets reaches the answer value', async ({ page }) => {
  await openCard(page);
  const ai = field(page, 'OPENAI_API_KEY');
  await ai.getByRole('group', { name: 'OPENAI_API_KEY on desktop' }).getByLabel(/OpenAI key, personal/).check();
  await expect(ai.getByText(/after 15 minutes without use/)).toBeVisible();
  const ceiling = ai.getByLabel('OPENAI_API_KEY access ends at most after');
  await expect(ceiling).toHaveValue(String(3600_000));
  await ceiling.selectOption({ label: '4 hours' });
  const before = Date.now();
  await page.getByRole('button', { name: 'Send answer' }).click();
  const values = await posted(page);
  const v = values['OPENAI_API_KEY'] as { grant: string; source: string; instance: string; until: number };
  expect({ ...v, until: 0 }).toEqual({ grant: 'openai', source: 'age', instance: 'desktop', until: 0 });
  expect(v.until).toBeGreaterThanOrEqual(before + 4 * 3600_000);
  expect(v.until).toBeLessThan(Date.now() + 4 * 3600_000 + 1000);
  // The fields the person left alone send nothing.
  expect(Object.keys(values).filter((k) => /^[A-Z_]+$/.test(k))).toEqual(['OPENAI_API_KEY']);
});

test('a candidate whose source is off shows as unavailable and cannot be picked', async ({ page }) => {
  await openCard(page);
  const off = field(page, 'OPENAI_API_KEY').getByLabel(/OpenAI key, team/);
  await expect(off).toBeDisabled();
  await expect(field(page, 'OPENAI_API_KEY').getByText(/unavailable: the vault is locked/)).toBeVisible();
});

test('each field of a card is answered on its own: one grant and one decline', async ({ page }) => {
  await openCard(page);
  await field(page, 'DATABASE_URL').getByLabel(/Staging database URL/).check();
  await field(page, 'OPENAI_API_KEY').getByLabel('Decline: the agent gets no access to OPENAI_API_KEY').check();
  await page.getByRole('button', { name: 'Send answer' }).click();
  const values = await posted(page);
  expect(values['DATABASE_URL']).toMatchObject({ grant: 'db-staging', source: 'age', instance: 'laptop' });
  expect(values['OPENAI_API_KEY']).toEqual({ decline: true });
  expect(values['DEPLOY_TOKEN']).toBeUndefined();
});

test('a typed value is sealed to the card key, and only its private key opens it', async ({ page }) => {
  await openCard(page);
  const token = field(page, 'DEPLOY_TOKEN');
  await expect(token.getByText(/No source on the inbox's computers holds DEPLOY_TOKEN/)).toBeVisible();
  await token.getByLabel('Type a value for DEPLOY_TOKEN instead').check();
  await token.getByLabel('Value of DEPLOY_TOKEN').fill('made-up-token-123');
  await page.getByRole('button', { name: 'Send answer' }).click();
  const values = await posted(page);
  const sealed = values['DEPLOY_TOKEN'] as Sealed;
  expect(sealed.alg).toBe('RSA-OAEP-256+A256GCM');
  expect(JSON.stringify(values)).not.toContain('made-up-token-123');
  const key = await crypto.subtle.importKey('jwk', TEST_PRIVATE_KEY, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']);
  expect(await openSealed(key, sealed)).toBe('made-up-token-123');
});

test('the keyboard alone grants a candidate, changes the ceiling and sends', async ({ page }) => {
  await openCard(page);
  const ai = field(page, 'OPENAI_API_KEY');
  const first = ai.getByRole('radio').first();
  await expect(first).toBeVisible();
  // Tab from the field before it until the focus reaches this field's radio group.
  await field(page, 'DATABASE_URL').getByRole('radio').last().focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  // Arrow keys move through the candidates and skip the unavailable one.
  await page.keyboard.press('ArrowDown');
  await expect(ai.getByRole('group', { name: 'OPENAI_API_KEY on desktop' }).getByRole('radio')).toBeChecked();
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeChecked();
  // Tab leaves the group for the ceiling, which the arrow keys change.
  await page.keyboard.press('Tab');
  const ceiling = ai.getByLabel('OPENAI_API_KEY access ends at most after');
  await expect(ceiling).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(ceiling).toHaveValue(String(4 * 3600_000));
  await page.getByRole('button', { name: 'Send answer' }).focus();
  await page.keyboard.press('Enter');
  const v = (await posted(page))['OPENAI_API_KEY'] as { grant: string; instance: string; until: number };
  expect(v).toMatchObject({ grant: 'openai', instance: 'laptop' });
  expect(v.until).toBeGreaterThan(Date.now() + 3 * 3600_000);
});

test('a granted field shows Revoke, which posts the field to the revoke route', async ({ page }) => {
  await story(page, 'cards--secret-access-granted');
  const calls: { url: string; body: unknown }[] = [];
  await page.exposeFunction('__record', (url: string, body: string) => { calls.push({ url, body: JSON.parse(body) }); });
  await page.evaluate(() => {
    const w = window as unknown as { __record: (u: string, b: string) => void };
    window.fetch = async (url, init) => { if (String(url).endsWith('/revoke')) w.__record(String(url), String(init?.body ?? 'null')); return Response.json({ ok: true }); };
  });
  await expect(page.getByText(/DATABASE_URL: granted db-staging from age on laptop until .*, case K7Q2/)).toBeVisible();
  await page.getByRole('button', { name: 'Revoke DATABASE_URL' }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]!.url).toMatch(/v1\/cards\/access-granted\/revoke$/);
  expect(calls[0]!.body).toEqual({ field: 'DATABASE_URL' });
});

test('a pick that a revision makes unavailable loses its grant controls and sends nothing', async ({ page }) => {
  await story(page, 'cards--secret-access-revised');
  const db = field(page, 'DATABASE_URL');
  await db.getByLabel(/Staging database URL/).check();
  await expect(db.getByLabel('DATABASE_URL access ends at most after')).toBeVisible();
  await page.getByRole('button', { name: 'Mark the source off' }).click();
  await expect(db.getByLabel(/Staging database URL/)).toBeDisabled();
  await expect(db.getByLabel('DATABASE_URL access ends at most after')).toHaveCount(0);
});
