// Web Push in the page, with a stand-in push service: a switch that subscribes, one push for a new card, and the reasons
// the switch gives where push is impossible. No test talks to Apple's or Google's push service: the browser's subscribe call
// is replaced, and the inbox's push request goes to a function in this file.
import { devices, expect, test, type Page } from '@playwright/test';
import { b64urlEncode, decryptPayload } from '../../src/core/webpush.ts';
import { startInbox, type TestInbox } from './inbox.ts';

test.use({ permissions: ['notifications'] });

interface Phone { endpoint: string; publicKey: string; privateKey: string; auth: string }
interface Push { url: string; body: Uint8Array<ArrayBuffer>; headers: Headers }

/** The keys of a browser's push subscription, which the page's stand-in `subscribe` hands out and the test decrypts with. */
async function newPhone(): Promise<Phone> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    endpoint: `https://push.example.invalid/send/${b64urlEncode(crypto.getRandomValues(new Uint8Array(12)))}`,
    publicKey: b64urlEncode(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)),
    privateKey: String(jwk.d),
    auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** Replace what a headless browser cannot do: it has no push service to subscribe to. */
async function stubBrowserPush(page: Page, phone: Phone): Promise<void> {
  await page.addInitScript((p) => {
    let kept: unknown = null;
    const sub = (key: ArrayBuffer) => ({
      endpoint: p.endpoint,
      options: { applicationServerKey: key },
      toJSON: () => ({ endpoint: p.endpoint, keys: { p256dh: p.publicKey, auth: p.auth } }),
      unsubscribe: async () => { kept = null; return true; },
    });
    PushManager.prototype.subscribe = async function subscribe(options?: PushSubscriptionOptionsInit) {
      const key = options?.applicationServerKey as Uint8Array;
      kept = sub(key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer);
      return kept as PushSubscription;
    };
    PushManager.prototype.getSubscription = async () => kept as PushSubscription | null;
    // Count the notifications the page makes itself: with push on, there must be none.
    const Real = window.Notification;
    (window as unknown as { shownByPage: number }).shownByPage = 0;
    window.Notification = Object.assign(function Notification(this: unknown, title: string, options?: NotificationOptions) {
      (window as unknown as { shownByPage: number }).shownByPage++;
      return new Real(title, options);
    } as unknown as typeof Notification, { permission: 'granted', requestPermission: async () => 'granted' });
    // Headless Chromium reports its notification permission as denied even when the test granted it, so the page is told what a real browser says.
  }, phone);
}

let inbox: TestInbox;
let pushes: Push[] = [];
let status = 201;
test.beforeAll(async () => {
  const stub = (async (url: string, init: RequestInit) => {
    pushes.push({ url, body: new Uint8Array(init.body as Uint8Array), headers: new Headers(init.headers) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  inbox = await startInbox({ fetch: stub });
});
test.afterAll(async () => { await inbox.close(); });
test.beforeEach(() => { pushes = []; status = 201; });

test('turning on Notify me subscribes the page, and a new card sends one push that only the phone can read', async ({ page }) => {
  const phone = await newPhone();
  await stubBrowserPush(page, phone);
  await inbox.open(page);
  const toggle = page.getByRole('switch', { name: 'Notify me' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(1);

  // The worker is registered at the inbox's own path, and it serves the manifest and icons an iPhone needs.
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  expect(scope).toBe(`${inbox.server.url}/`);
  const manifest = await (await page.request.get(`${inbox.server.url}/manifest.webmanifest`)).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await page.request.get(`${inbox.server.url}/${icon.src}`)).headers()['content-type']).toBe('image/png');

  const card = await inbox.agent.post({ agent: 'push-agent', title: 'Deploy to production?', text: 'Details that never leave the inbox.' });
  await expect.poll(() => pushes.length).toBe(1);
  await page.waitForTimeout(700);
  expect(pushes.length, 'one card, one push').toBe(1);
  expect(pushes[0]?.url).toBe(phone.endpoint);
  expect(pushes[0]?.headers.get('content-encoding')).toBe('aes128gcm');
  const plain = await decryptPayload(pushes[0]!.body, { publicKey: phone.publicKey, privateKey: phone.privateKey, auth: phone.auth });
  expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ id: card.id, title: 'Deploy to production?' });
  expect(new TextDecoder('latin1').decode(pushes[0]!.body)).not.toContain('Deploy');

  // The page is open and showed the card, and made no notification of its own, so the phone sees one.
  await expect(page.getByText('Deploy to production?').first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { shownByPage: number }).shownByPage)).toBe(0);

  // Turning it off tells the inbox, so the next card sends nothing.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(0);
  await inbox.agent.post({ agent: 'push-agent', title: 'Another one' });
  await page.waitForTimeout(500);
  expect(pushes.length).toBe(1);
});

test('Notify me stays on the page, greyed out, and says why where push is impossible', async ({ browser }) => {
  const cases: { name: string; reason: string; context: Parameters<typeof browser.newContext>[0]; script?: string }[] = [
    { name: 'a plain http address', reason: 'needs an https address', context: { permissions: ['notifications'] }, script: "Object.defineProperty(window, 'isSecureContext', { value: false })" },
    { name: 'iPhone Safari outside the Home Screen', reason: 'add this page to your Home Screen first', context: { ...devices['iPhone 13'], permissions: ['notifications'] } },
    { name: 'a browser that blocks notifications', reason: 'the browser blocks notifications', context: { permissions: [] }, script: "Object.defineProperty(Notification, 'permission', { get: () => 'denied' })" },
  ];
  for (const c of cases) {
    const context = await browser.newContext(c.context);
    const page = await context.newPage();
    if (c.script) await page.addInitScript(c.script);
    await inbox.open(page);
    const toggle = page.getByRole('switch', { name: 'Notify me' });
    await expect(toggle, c.name).toBeVisible();
    await expect(toggle, c.name).toBeDisabled();
    await expect(toggle, c.name).not.toBeChecked();
    await expect(page.locator('.notify-why'), c.name).toHaveText(c.reason);
    await context.close();
  }
});

test('an older Notify me that is on stays on and can be turned off where push is impossible', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'isSecureContext', { value: false }); localStorage.setItem('notify:on', 'true'); });
  await inbox.open(page);
  const toggle = page.getByRole('switch', { name: 'Notify me' });
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('notify:on'))).toBe('false');
  await expect(toggle).toBeDisabled();
  await expect(page.locator('.notify-why')).toHaveText('needs an https address');
});

test('turning the switch off removes the device even after the browser started blocking notifications', async ({ page }) => {
  await stubBrowserPush(page, await newPhone());
  await inbox.open(page);
  const toggle = page.getByRole('switch', { name: 'Notify me' });
  await toggle.click();
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(1);
  await page.evaluate(() => { (window.Notification as unknown as { permission: string }).permission = 'denied'; });
  // A new card makes the page draw again, with the browser now blocking notifications.
  await inbox.agent.post({ agent: 'push-agent', title: 'Redraw the page' });
  await expect(page.locator('.notify-why')).toHaveText('the browser blocks notifications');
  await toggle.click();
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(0);
});

test('a device the push service forgot is removed, and the page saves it again when it opens', async ({ page }) => {
  const phone = await newPhone();
  await stubBrowserPush(page, phone);
  await inbox.open(page);
  await page.getByRole('switch', { name: 'Notify me' }).click();
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(1);
  status = 410;
  await inbox.agent.post({ agent: 'push-agent', title: 'Gone' });
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(0);
  status = 201;
  // A reload starts a page whose stand-in browser has no subscription, as a browser that dropped it would: the switch is still on, and the page subscribes again.
  await page.reload();
  await page.locator('.bar .pill.on').waitFor();
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(1);
  await page.getByRole('switch', { name: 'Notify me' }).click();
  await expect.poll(() => inbox.server.inbox.pushCount()).toBe(0);
});
