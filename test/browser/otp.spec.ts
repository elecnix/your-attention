// The otp field on the real page: the person reads the key, the purpose, the session that asks and the inbox that holds
// the key, approves, and sends. The answer holds a ticket and no code, and the card in the outbox says that a code was
// approved, then when the inbox issued it once the session redeems the ticket.
import { expect, test } from '@playwright/test';
import { base32Encode, totp, type OtpApproval } from '../../src/core/otp.ts';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { startInbox, type TestInbox } from './inbox.ts';

// The RFC 6238 test key for SHA-1, not anyone's authenticator key.
const KEY = new TextEncoder().encode('12345678901234567890');
const SESSION = 's-otp';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  const res = await fetch(`${inbox.server.url}/v1/otp/keys/npm`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${inbox.server.ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: base32Encode(KEY), code: await totp(KEY, Date.now()), allow: [SESSION] }),
  });
  expect(res.status).toBe(201);
});
test.afterAll(async () => { await inbox.close(); });

test('the person approves a code on the card, never sees one, and the card says when the inbox issued it', async ({ page }) => {
  const session = await newSealKeys();
  await inbox.agent.post({
    id: 'otp', agent: SESSION, title: 'Approve the npm publish of your-attention 1.4.0?', priority: 'now',
    origin: { harness: 'claude', name: 'release agent', host: 'test-host' },
    body: `root = Card([intro, npm])\nintro = TextContent("The automated review passed.")\nnpm = widget otp ${JSON.stringify({ name: 'NPM_OTP', key: 'npm', purpose: 'npm stage approve your-attention@1.4.0', publicKey: JSON.stringify(session.publicKey) })}`,
  });
  await inbox.open(page);
  const field = page.locator('fieldset.otp');
  await expect(field.locator('legend')).toHaveText('One-time code from the key npm');
  await expect(field.locator('.otp-purpose')).toHaveText('npm stage approve your-attention@1.4.0');
  await expect(field).toContainText('release agent on test-host');
  await expect(field).toContainText(/the laptop inbox on .*otp-keys\.json, which only its user reads/);
  await field.getByLabel('Approve one code from npm').check();
  await page.getByRole('button', { name: 'Send answer' }).click();

  await expect.poll(async () => (await inbox.detail('otp')).answer?.values['NPM_OTP']).toBeTruthy();
  const approval = (await inbox.detail('otp')).answer!.values['NPM_OTP'] as OtpApproval;
  expect(approval.key).toBe('npm');
  expect(approval.issuedAt).toBeUndefined();

  // The session redeems the ticket, and the code opens only with its own key.
  const r = await inbox.agent.otpRedeem(approval.ticket, SESSION);
  const code = await openSealed(session.privateKey, r.sealed);
  expect(code).toMatch(/^\d{6}$/);
  await page.getByRole('button', { name: /Approve the npm publish of your-attention 1\.4\.0\?/ }).click();
  await expect(page.locator('body')).toContainText(/Approved one code from npm, issued at/);
  expect(await page.locator('body').innerText()).not.toContain(code);
  expect(JSON.stringify(await inbox.detail('otp'))).not.toContain(code);
});
