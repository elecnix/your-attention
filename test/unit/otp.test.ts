// One-time codes: RFC 6238 and the verifier's window, enrollment, the otp card and its four refusals, the ticket an
// approval mints, and the redemption that seals a fresh code to the posting session. SPEC.md#one-time-codes holds the
// contract. The last test searches every place a code could leak for the digits the session received.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sealedOtpKeys } from '../../src/cloudflare/otp-keys.ts';
import { fileOtpKeys, OTP_KEYS_FILE } from '../../src/node/otp-keys.ts';
import { describeAnswer, type Client } from '../../src/client.ts';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { base32Decode, base32Encode, isOtpApproval, issueCode, keyChecksum, readKey, STEP_MS, TICKET_MS, totp, verifyTotp, type OtpApproval, type OtpKeyStore } from '../../src/core/otp.ts';
import { isSealed, newSealKeys, oneTimeCodes, openSealed } from '../../src/core/sealed.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent, Answer, NewCard } from '../../src/core/types.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { createHandler } from '../../src/core/http.ts';

// The RFC 6238 test key for SHA-1: the ASCII digits 1 to 0, twice. Not anyone's authenticator key.
const RFC_KEY = new TextEncoder().encode('12345678901234567890');
const KEY_TEXT = base32Encode(RFC_KEY);
const agent: Caller = { token: 'ta', role: 'agent' };
const otherToken: Caller = { token: 'tb', role: 'agent' };
const owner: Caller = { token: 'to', role: 'owner' };
const extension: Caller = { token: 'te', role: 'extension' };
// A moment 10 seconds into its step, so a redemption made at once has 20 seconds left.
const NOW = 1_800_000_000_000 + 10_000;
const SESSION = 'release-session';

/** A key store in memory, which records what it was asked, and can damage a key the way a bad disk would. */
function memoryKeys() {
  const keys = new Map<string, Uint8Array>();
  const store: OtpKeyStore & { damage: (label: string) => void; keys: Map<string, Uint8Array> } = {
    holder: 'the test inbox, in memory',
    keys,
    save: async (label, key) => { keys.set(label, new Uint8Array(key)); },
    load: async (label) => keys.get(label),
    remove: async (label) => { keys.delete(label); },
    damage: (label) => { const k = keys.get(label)!; k[0] = k[0]! ^ 0x01; },
  };
  return store;
}

async function setup(opts: { allow?: string[]; store?: boolean } = {}) {
  let t = NOW;
  const keys = memoryKeys();
  const sent: string[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body)); return new Response(null, { status: 200 }); }) as typeof fetch;
  const storage = new MemoryStorage();
  const inbox = new Inbox(storage, () => t, undefined, { ...(opts.store === false ? {} : { otpKeys: keys }), fetch: fetcher });
  if (opts.store !== false) await inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: await totp(RFC_KEY, NOW), allow: opts.allow ?? [SESSION] });
  const session = await newSealKeys();
  return { inbox, storage, keys, sent, session, clock: { now: () => t, advance: (ms: number) => { t += ms; } } };
}

const otpBody = (publicKey: JsonWebKey, opts: { key?: string; purpose?: string; name?: string } = {}) =>
  `root = Card([intro, npm])\nintro = TextContent("The tarball passed the review.")\nnpm = widget otp ${JSON.stringify({ name: opts.name ?? 'NPM_OTP', key: opts.key ?? 'npm', purpose: opts.purpose ?? 'npm stage publish your-attention@1.4.0', publicKey: JSON.stringify(publicKey) })}`;

const post = (inbox: Inbox, publicKey: JsonWebKey, opts: { agent?: string; id?: string; key?: string; purpose?: string } = {}) =>
  inbox.postCard(agent, { id: opts.id ?? 'c1', agent: opts.agent ?? SESSION, title: 'Publish 1.4.0 to npm?', body: otpBody(publicKey, opts) });

const rejects = (status: number, message: RegExp) => (e: unknown): boolean => e instanceof InboxError && e.status === status && message.test(e.message);

/** Call the HTTP handler with a new token of one role, which is never the token that posted a card here. */
async function call(inbox: Inbox, role: 'owner' | 'agent' | 'extension', method: string, route: string, body?: unknown): Promise<Response> {
  const { secret } = await inbox.createToken(role, role);
  return createHandler(inbox)(new Request(`http://inbox.test${route}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
}

const tickets = (inbox: Inbox): number => (inbox as unknown as { store: MemoryStorage }).store.list('otptickets').length;
const storedAnswer = (inbox: Inbox, id: string): Answer => (inbox as unknown as { store: MemoryStorage }).store.get<Answer>('answers', id)!;

describe('RFC 6238 codes', () => {
  it('computes the six-digit codes of the RFC 6238 SHA-1 test vectors', async () => {
    // Appendix B gives eight digits. Six digits are the same number modulo 10^6.
    const vectors: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
    for (const [seconds, code] of vectors) assert.equal(await totp(RFC_KEY, seconds * 1000), code, `T = ${seconds}`);
  });

  it('accepts the code of the previous and of the next step, and refuses one two steps away', async () => {
    const at = 1111111111_000;
    for (const steps of [-1, 0, 1]) assert.equal(await verifyTotp(RFC_KEY, await totp(RFC_KEY, at + steps * STEP_MS), at), true, `${steps} steps`);
    for (const steps of [-2, 2]) assert.equal(await verifyTotp(RFC_KEY, await totp(RFC_KEY, at + steps * STEP_MS), at), false, `${steps} steps`);
    assert.equal(await verifyTotp(RFC_KEY, '12345', at), false, 'five digits');
    assert.equal(await verifyTotp(RFC_KEY, '1234567', at), false, 'seven digits');
  });

  it('reads base32 in any case with spaces, and the secret of an otpauth address', () => {
    assert.deepEqual(base32Decode(KEY_TEXT.toLowerCase().replace(/(.{4})/g, '$1 ')), RFC_KEY);
    assert.deepEqual(readKey(`otpauth://totp/npm:someone?secret=${KEY_TEXT}&issuer=npm`), RFC_KEY);
    assert.throws(() => readKey(`otpauth://hotp/npm?secret=${KEY_TEXT}`), rejects(400, /time-based/));
    assert.throws(() => readKey(`otpauth://totp/npm?secret=${KEY_TEXT}&algorithm=SHA256`), rejects(400, /SHA1 codes only/));
    assert.throws(() => readKey(`otpauth://totp/npm?secret=${KEY_TEXT}&digits=8`), rejects(400, /8 digits/));
    assert.throws(() => readKey('GEZDGNBV'), rejects(400, /at least 10/));
    assert.throws(() => readKey('GEZDGNBVGY3TQOJ1GEZDGNBVGY3TQOJQ'), rejects(400, /not base32/));
  });

  it('refuses to issue a code from a key whose bytes changed, and a code computed from a damaged key', async () => {
    const checksum = await keyChecksum(RFC_KEY);
    const damaged = new Uint8Array(RFC_KEY);
    damaged[0] = damaged[0]! ^ 0x01;
    await assert.rejects(issueCode('npm', damaged, checksum, NOW), rejects(500, /the key npm is damaged/));
    // The key in storage is intact, but the generator computes from a damaged copy: the verifier stops that code.
    await assert.rejects(issueCode('npm', RFC_KEY, checksum, NOW, (_key, at) => totp(damaged, at)), rejects(500, /failed the inbox's own check/));
    const issued = await issueCode('npm', RFC_KEY, checksum, NOW);
    assert.equal(issued.code, await totp(RFC_KEY, NOW));
    assert.equal(issued.expiresAt, NOW - 10_000 + STEP_MS);
  });
});

describe('enrolling a key', () => {
  it('takes a key only from the owner, with a current code that proves it matches the authenticator', async () => {
    const keys = memoryKeys();
    const inbox = new Inbox(new MemoryStorage(), () => NOW, undefined, { otpKeys: keys });
    const code = await totp(RFC_KEY, NOW);
    await assert.rejects(inbox.otpEnroll(agent, 'npm', { key: KEY_TEXT, code, allow: [SESSION] }), rejects(403, /only the owner enrolls/));
    const wrong = code === '000000' ? '000001' : '000000';
    await assert.rejects(inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: wrong, allow: [SESSION] }), rejects(400, /does not match the key/));
    assert.equal(keys.keys.size, 0, 'a refused enrollment stores nothing');
    const info = await inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code, allow: [SESSION] });
    assert.deepEqual(info, { label: 'npm', allow: [SESSION], enrolledAt: NOW });
    assert.deepEqual(keys.keys.get('npm'), RFC_KEY);
    const listed = inbox.otpKeyList(owner);
    assert.equal(listed.holder, 'the test inbox, in memory');
    assert.deepEqual(listed.keys, [info]);
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(KEY_TEXT), 'the list never holds the key');
    assert.throws(() => inbox.otpKeyList(agent), rejects(403, /only the owner/));
  });

  it('answers that an inbox without a key store keeps no keys', async () => {
    const inbox = new Inbox(new MemoryStorage(), () => NOW);
    await assert.rejects(inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: await totp(RFC_KEY, NOW), allow: [SESSION] }), rejects(404, /keeps no one-time code keys/));
  });

  it('keeps the allowlist when the owner enrolls a key again without naming sessions', async () => {
    const { inbox } = await setup({ allow: [SESSION, 'twin'] });
    const again = await inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: await totp(RFC_KEY, NOW) });
    assert.deepEqual(again.allow, [SESSION, 'twin']);
    const replaced = await inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: await totp(RFC_KEY, NOW), allow: ['other'] });
    assert.deepEqual(replaced.allow, ['other']);
  });

  it('adds and removes sessions from the allowlist, and removes the key', async () => {
    const { inbox, keys } = await setup();
    assert.deepEqual(inbox.otpAllow(owner, 'npm', { add: ['other-session'] }).allow, [SESSION, 'other-session']);
    assert.deepEqual(inbox.otpAllow(owner, 'npm', { remove: [SESSION] }).allow, ['other-session']);
    assert.throws(() => inbox.otpAllow(agent, 'npm', { add: ['me'] }), rejects(403, /only the owner/));
    await inbox.otpRemove(owner, 'npm');
    assert.equal(keys.keys.size, 0);
    assert.deepEqual(inbox.otpKeyList(owner).keys, []);
  });
});

describe('the otp card', () => {
  it('places a OneTimeCode with the key, the purpose and the public key, and the card says which inbox holds the key', async () => {
    const { inbox, session } = await setup();
    const card = post(inbox, session.publicKey);
    assert.deepEqual(card.otp, ['NPM_OTP']);
    assert.equal(card.otpHolder, 'the test inbox, in memory');
    assert.deepEqual(oneTimeCodes(card.body ?? '').map(({ name, key, purpose }) => ({ name, key, purpose })), [{ name: 'NPM_OTP', key: 'npm', purpose: 'npm stage publish your-attention@1.4.0' }]);
  });

  it('refuses a card without a purpose, for a key nobody enrolled, or on an inbox with no key store', async () => {
    const { inbox, session } = await setup();
    assert.throws(() => post(inbox, session.publicKey, { purpose: ' ' }), rejects(400, /needs a purpose/));
    assert.throws(() => post(inbox, session.publicKey, { key: 'github' }), rejects(400, /no key named github is enrolled/));
    const none = (await setup({ store: false })).inbox;
    assert.throws(() => post(none, session.publicKey), rejects(400, /keeps no one-time code keys/));
  });

  it('refuses a session the key does not allow, and says how the person adds it', async () => {
    const { inbox, session } = await setup();
    assert.throws(() => post(inbox, session.publicKey, { agent: 'stray-session' }),
      rejects(403, /session stray-session may not ask for a code from the key npm\. The person allows it with `your-attention otp allow npm stray-session`/));
  });

  it('mints a ticket on approval, and nothing on a decline or an empty field', async () => {
    const { inbox, session } = await setup();
    post(inbox, session.publicKey);
    const approved = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, by: owner });
    const v = approved.values['NPM_OTP'] as OtpApproval;
    assert.ok(isOtpApproval(v));
    assert.deepEqual({ ...v, ticket: 'T' }, { ticket: 'T', key: 'npm', purpose: 'npm stage publish your-attention@1.4.0', approvedAt: NOW, expiresAt: NOW + TICKET_MS });
    assert.match(describeAnswer(inbox.getCard('c1'), approved), new RegExp(`NPM_OTP: the person approved a code from the key npm for "npm stage publish your-attention@1.4.0"\\. Call card_otp with ticket ${v.ticket} right before the command`));

    post(inbox, session.publicKey, { id: 'c2' });
    const declined = await inbox.answer('c2', { values: { NPM_OTP: 'decline' }, by: owner });
    assert.deepEqual(declined.values['NPM_OTP'], { decline: true });
    assert.equal(describeAnswer(inbox.getCard('c2'), declined), 'NPM_OTP: the person declined, so there is no ticket and no code. Do not run the command that needs it.');

    post(inbox, session.publicKey, { id: 'c3' });
    const empty = await inbox.answer('c3', { values: {}, by: owner });
    assert.equal(empty.values['NPM_OTP'], undefined);
    assert.match(describeAnswer(inbox.getCard('c3'), empty), /NPM_OTP: the person did not approve a code, so there is no ticket/);
    assert.equal(tickets(inbox), 1, 'only the approval minted a ticket');
  });

  it('takes an approval only from the owner, once, and never after the agent closed the card', async () => {
    const { inbox, session } = await setup();
    post(inbox, session.publicKey);
    await assert.rejects(inbox.answer('c1', { values: { NPM_OTP: 'approve' } }), rejects(403, /only the owner approves a one-time code/));
    const res = await call(inbox, 'agent', 'POST', '/v1/cards/c1/answer', { values: { NPM_OTP: 'approve' } });
    assert.equal(res.status, 403);
    await assert.rejects(inbox.answer('c1', { values: { NPM_OTP: 'yes' }, by: owner }), rejects(400, /takes "approve" or "decline"/));
    const first = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, by: owner });
    // The same decision again, as a changed comment sends, keeps the ticket and mints no other.
    const again = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, comment: 'thanks', by: owner });
    assert.deepEqual(again.values['NPM_OTP'], first.values['NPM_OTP']);
    await assert.rejects(inbox.answer('c1', { values: { NPM_OTP: 'decline' }, by: owner }), rejects(409, /already approved.*final/));
    assert.equal(tickets(inbox), 1);

    post(inbox, session.publicKey, { id: 'c2' });
    inbox.close(agent, 'c2', 'retracted', 'released already');
    // A late answer reaches the agent with its comment, as any late answer does, and its approval mints nothing.
    const late = await inbox.answer('c2', { values: { NPM_OTP: 'approve' }, comment: 'too late?', by: owner });
    assert.equal(late.values['NPM_OTP'], undefined);
    assert.equal(late.comment, 'too late?');
    assert.match(describeAnswer(inbox.getCard('c2'), late), /NPM_OTP: not approved, because the card was closed when the person answered, so there is no ticket/);
    assert.equal(tickets(inbox), 1);
  });

  it('takes an approval only for the version the person read, so a revision to another key mints nothing', async () => {
    const { inbox, session } = await setup();
    post(inbox, session.publicKey);
    post(inbox, session.publicKey, { purpose: 'npm stage publish another-package@9.9.9' });
    assert.equal(inbox.getCard('c1').version, 2);
    await assert.rejects(inbox.answer('c1', { values: { NPM_OTP: 'approve' }, version: 1, by: owner }), rejects(409, /changed to version 2 after you read version 1/));
    assert.equal(tickets(inbox), 0);
    const ok = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, version: 2, by: owner });
    assert.equal((ok.values['NPM_OTP'] as OtpApproval).purpose, 'npm stage publish another-package@9.9.9');
  });

  it('keeps the ticket from hooks after a revision drops the otp field', async () => {
    const { inbox, session } = await setup();
    const hooks: unknown[] = [];
    inbox.connectExtension(extension, { name: 'watch', hooks: ['answer.saved'] }, (ev) => hooks.push(ev));
    post(inbox, session.publicKey);
    const approved = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, by: owner });
    const ticket = (approved.values['NPM_OTP'] as OtpApproval).ticket;
    inbox.postCard(agent, { id: 'c1', agent: SESSION, title: 'Publish 1.4.0 to npm?', text: 'The code is no longer needed.' });
    await inbox.answer('c1', { values: {}, comment: 'ok', version: 2, by: owner });
    while (inbox.deliveries.size) await Promise.all([...inbox.deliveries]);
    assert.ok(hooks.length >= 2);
    assert.ok(!JSON.stringify(hooks).includes(ticket), 'no hook call holds the ticket');
  });

  it('keeps the approval out of a dismissal', async () => {
    const { inbox, session } = await setup();
    post(inbox, session.publicKey);
    inbox.dismiss(owner, 'c1', { values: { NPM_OTP: 'approve', note: 'n' } });
    assert.equal(tickets(inbox), 0);
  });
});

describe('redeeming a ticket', () => {
  async function approved(opts: { allow?: string[] } = {}) {
    const s = await setup(opts);
    post(s.inbox, s.session.publicKey);
    const answer = await s.inbox.answer('c1', { values: { NPM_OTP: 'approve' }, by: owner });
    return { ...s, ticket: (answer.values['NPM_OTP'] as OtpApproval).ticket };
  }

  it('seals a code fresh from the key to the posting session, once, and records when, never which', async () => {
    const { inbox, session, ticket, clock } = await approved();
    clock.advance(4 * 60_000);
    const at = NOW + 4 * 60_000;
    const r = await inbox.otpRedeem(agent, { ticket, agent: SESSION });
    assert.ok(isSealed(r.sealed));
    assert.equal(await openSealed(session.privateKey, r.sealed), await totp(RFC_KEY, at), 'the code of the moment of redemption, not of the approval');
    assert.deepEqual({ ...r, sealed: undefined }, { card: 'c1', field: 'NPM_OTP', key: 'npm', purpose: 'npm stage publish your-attention@1.4.0', sealed: undefined, issuedAt: at, expiresAt: Math.floor(at / STEP_MS) * STEP_MS + STEP_MS });
    const stored = storedAnswer(inbox, 'c1').values['NPM_OTP'] as OtpApproval;
    assert.equal(stored.issuedAt, at);
    assert.equal(inbox.otpKeyList(owner).keys[0]?.lastIssuedAt, at);
  });

  it('refuses a used ticket, and says when it was used', async () => {
    const { inbox, ticket } = await approved();
    await inbox.otpRedeem(agent, { ticket, agent: SESSION });
    await assert.rejects(inbox.otpRedeem(agent, { ticket, agent: SESSION }), rejects(409, /was used at \d\d:\d\d:\d\d UTC: a ticket gives one code\. Post a new otp card/));
  });

  it('gives one code when two redemptions arrive at the same moment', async () => {
    const { inbox, ticket } = await approved();
    const results = await Promise.allSettled([inbox.otpRedeem(agent, { ticket, agent: SESSION }), inbox.otpRedeem(agent, { ticket, agent: SESSION })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  });

  it('refuses a ticket after its 10 minutes', async () => {
    const { inbox, ticket, clock } = await approved();
    clock.advance(TICKET_MS + 1);
    await assert.rejects(inbox.otpRedeem(agent, { ticket, agent: SESSION }), rejects(410, /ended at .* UTC, 10 minutes after the approval/));
  });

  it('refuses another token, another session, and a session the person removed from the key since the approval', async () => {
    const { inbox, ticket } = await approved({ allow: [SESSION, 'twin'] });
    await assert.rejects(inbox.otpRedeem(otherToken, { ticket, agent: SESSION }), rejects(403, /belongs to the session that posted card c1/));
    await assert.rejects(inbox.otpRedeem(agent, { ticket, agent: 'twin' }), rejects(403, /belongs to the session that posted card c1/));
    await assert.rejects(inbox.otpRedeem(agent, { ticket: 'nope', agent: SESSION }), rejects(404, /no ticket nope/));
    inbox.otpAllow(owner, 'npm', { remove: [SESSION] });
    await assert.rejects(inbox.otpRedeem(agent, { ticket, agent: SESSION }), rejects(403, /`your-attention otp allow npm release-session`/));
  });

  it('refuses a damaged key rather than send a code that would fail, and the ticket still works once the key is enrolled again', async () => {
    const { inbox, keys, ticket } = await approved();
    keys.damage('npm');
    await assert.rejects(inbox.otpRedeem(agent, { ticket, agent: SESSION }), rejects(500, /the key npm is damaged/));
    assert.equal((storedAnswer(inbox, 'c1').values['NPM_OTP'] as OtpApproval).issuedAt, undefined, 'no code was issued');
    await inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: await totp(RFC_KEY, NOW), allow: [SESSION] });
    const r = await inbox.otpRedeem(agent, { ticket, agent: SESSION });
    assert.ok(isSealed(r.sealed));
  });

  it('answers each refusal on the route with its status and sentence', async () => {
    const { inbox, ticket } = await approved();
    const route = (role: Caller['role'], body: unknown) => call(inbox, role, 'POST', '/v1/otp/redeem', body);
    // The handler's tokens are not the token that posted the card.
    const res = await route('agent', { ticket, agent: SESSION });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /belongs to the session that posted card c1/);
    assert.equal((await route('owner', { ticket, agent: SESSION })).status, 403);
    assert.equal((await call(inbox, 'agent', 'GET', '/v1/otp/keys')).status, 403);
    assert.equal((await call(inbox, 'owner', 'GET', '/v1/otp/keys')).status, 200);
  });

  it('reads a key label once, so an escaped percent sign gets the route\'s own refusal', async () => {
    const { inbox } = await approved();
    const res = await call(inbox, 'owner', 'PUT', '/v1/otp/keys/%25', { key: KEY_TEXT, code: '000000', allow: [SESSION] });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /a key label is 1 to 40 lowercase letters/);
    assert.equal((await call(inbox, 'agent', 'PATCH', '/v1/otp/keys/npm%252Dx', { add: ['me'] })).status, 403);
  });

  it('leaves the ticket unused when the session cannot hand the code to a command', async () => {
    const { inbox, ticket, clock } = await approved();
    const ctx = { inbox: clientOver(inbox), secrets: new SecretRequests(clock.now), agent: SESSION, origin: async () => undefined, arrival: 'later', now: clock.now, sleep: async () => {} };
    await assert.rejects(runTool({ ...ctx, deliverGrants: async () => 'This session could not open the socket its Bash commands read secrets from.' }, 'card_otp', { ticket }),
      /could not open the socket .* The ticket is not used, so it still works once that is fixed\./);
    assert.equal(tickets(inbox), 1);
    assert.equal((storedAnswer(inbox, 'c1').values['NPM_OTP'] as OtpApproval).issuedAt, undefined);
  });
});

describe('the code never leaves the session', () => {
  it('keeps the digits out of the answer, the card, its history, the agent stream, hooks, webhooks, tool results, the log and storage', async () => {
    const logged: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const { inbox, storage, sent, clock } = await setup();
      const hooks: unknown[] = [];
      inbox.connectExtension(extension, { name: 'watch', hooks: ['answer.saved', 'card.created'] }, (ev) => hooks.push(ev));
      const sub = inbox.subscribe(agent, { agent: SESSION, kind: 'system', title: 'Subscribe', system: { type: 'subscribe', webhook: { url: 'https://example.com/hooks/abc', headers: {} }, events: ['answer'] } } as NewCard);
      await inbox.answer(sub.card.id, { values: { choice: 'approve' }, by: owner });
      const heard: AgentEvent[] = [];
      inbox.connect(agent, SESSION, (ev) => heard.push(ev));
      const pageEvents: unknown[] = [];
      inbox.subscribePage((ev: unknown) => pageEvents.push(ev));

      // The session posts with card_post, as an agent does, and keeps the private key.
      const secrets = new SecretRequests(() => clock.now());
      const client = clientOver(inbox);
      const ctx = { inbox: client, secrets, agent: SESSION, origin: async () => undefined, arrival: 'as a channel event' };
      const body = `root = Card([npm])\nnpm = widget otp ${JSON.stringify({ name: 'NPM_OTP', key: 'npm', purpose: 'npm stage publish your-attention@1.4.0' })}`;
      await runTool(ctx, 'card_post', { id: 'c1', title: 'Publish 1.4.0 to npm?', text: 'The tarball is staged.', body });
      // A revision, so the card's history holds a version to search as well.
      const posted = await runTool(ctx, 'card_post', { id: 'c1', title: 'Publish 1.4.0 to npm?', text: 'The tarball passed the review.', body });
      assert.equal(inbox.getCard('c1').history?.length, 1);
      const answer = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, by: owner });
      const ticket = (answer.values['NPM_OTP'] as OtpApproval).ticket;
      while (inbox.deliveries.size) await Promise.all([...inbox.deliveries]);
      const ev = heard.find((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer' && e.card.id === 'c1');
      assert.ok(ev, 'the agent stream got the answer');
      const received = await secrets.receive(ev.card, ev.answer);
      const waits: number[] = [];
      const redeemed = await runTool({ inbox: client, secrets, agent: SESSION, origin: async () => undefined, arrival: 'as a channel event', now: clock.now, sleep: async (ms) => { waits.push(ms); } }, 'card_otp', { ticket });
      assert.deepEqual(waits, [], 'with 20 seconds of the step left, card_otp redeems at once');
      const at = clock.now();
      const code = await totp(RFC_KEY, at);
      // The search looks for the right string: the session's commands get exactly this code.
      assert.equal(secrets.env(SESSION)['NPM_OTP'], code);
      assert.match(redeemed, /\$NPM_OTP/);
      const after = storedAnswer(inbox, 'c1');
      // The record says that a code was issued, and when.
      assert.equal((after.values['NPM_OTP'] as OtpApproval).issuedAt, at);
      const places: Record<string, unknown> = {
        'card_post result': posted,
        'the answer as stored': after,
        'the answer as answer() returned it': answer,
        'the card record': inbox.getCard('c1'),
        'the card history': inbox.getCard('c1').history ?? [],
        'the agent stream': heard,
        'the page events': pageEvents,
        'the hooks': hooks,
        'the webhooks': sent,
        'the answer text for the model': [describeAnswer(ev.card, ev.answer), received],
        'the card_otp result': redeemed,
        'the log': logged,
        'every collection in storage': (storage as unknown as { data: Map<string, Map<string, string>> }).data,
      };
      for (const [where, value] of Object.entries(places)) {
        const text = typeof value === 'string' ? value : JSON.stringify(value, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v));
        // The core logs nothing on this path, so only the log may be empty: test/integration/otp.test.ts searches what a
        // real serve process prints.
        assert.ok(typeof text === 'string' && (text.length > 2 || where === 'the log'), `${where} has something to search`);
        assert.ok(!text.includes(code), `the code ${'*'.repeat(code.length)} appears in ${where}`);
        assert.ok(!text.includes(KEY_TEXT), `the key appears in ${where}`);
      }
      // Hooks and webhooks hear that a code was approved, without the ticket.
      const hook = hooks.find((h) => (h as { hook?: string; answer?: Answer }).hook === 'answer.saved' && (h as { answer: Answer }).answer.card === 'c1') as { answer: Answer } | undefined;
      assert.deepEqual(hook?.answer.values['NPM_OTP'], { approved: true, key: 'npm', purpose: 'npm stage publish your-attention@1.4.0', expiresAt: NOW + TICKET_MS });
      for (const body of sent) assert.ok(!body.includes(ticket), 'a webhook never gets the ticket');
    } finally {
      methods.forEach((m, i) => { console[m] = saved[i]!; });
    }
  });
});

describe('where the keys live', () => {
  it('keeps the keys of your own inbox in one file of mode 0600 beside owner-token, and refuses a key damaged on disk', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-otp-'));
    try {
      const keys = fileOtpKeys(home, 'test-machine');
      assert.match(keys.holder, /^your own inbox on test-machine, in .*otp-keys\.json, which only its user reads$/);
      const inbox = new Inbox(new MemoryStorage(), () => NOW, undefined, { otpKeys: keys });
      await inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: await totp(RFC_KEY, NOW), allow: [SESSION] });
      const file = path.join(home, OTP_KEYS_FILE);
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(await keys.load('npm'), RFC_KEY);
      const session = await newSealKeys();
      post(inbox, session.publicKey);
      const answer = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, by: owner });
      // One character of the stored key changes, as a stray edit or a bad disk would change it.
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
      fs.writeFileSync(file, JSON.stringify({ npm: `${stored['npm']!.startsWith('A') ? 'B' : 'A'}${stored['npm']!.slice(1)}` }));
      await assert.rejects(inbox.otpRedeem(agent, { ticket: (answer.values['NPM_OTP'] as OtpApproval).ticket, agent: SESSION }), rejects(500, /the key npm is damaged/));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('names the key file, and quotes none of it, when the file does not parse', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-otp-'));
    try {
      const keys = fileOtpKeys(home, 'test-machine');
      // A file cut off in the middle of the key, as a full disk would leave it.
      fs.writeFileSync(path.join(home, OTP_KEYS_FILE), `{"npm": "${KEY_TEXT}`);
      await assert.rejects(keys.load('npm'), (e: Error) => /otp-keys\.json is not a JSON object of labels and keys$/.test(e.message) && !e.message.includes(KEY_TEXT.slice(0, 8)));
      // Enrolling again replaces the broken file, which moves aside with its mode, so the person can recover from it.
      await keys.save('npm', RFC_KEY);
      assert.deepEqual(await keys.load('npm'), RFC_KEY);
      const aside = fs.readdirSync(home).filter((f) => f.startsWith(`${OTP_KEYS_FILE}.broken-`));
      assert.equal(aside.length, 1);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, aside[0]!)).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the hosted keys as ciphertext under the Worker secret, which another inbox or another secret cannot open', async () => {
    const storage = new MemoryStorage();
    const keys = sealedOtpKeys('worker-secret-for-tests', 'inbox-a', storage);
    await keys.save('npm', RFC_KEY);
    assert.deepEqual(await keys.load('npm'), RFC_KEY);
    assert.doesNotMatch(JSON.stringify(storage.list('otpsealed')), new RegExp(`${KEY_TEXT}|12345678901234567890`));
    await assert.rejects(sealedOtpKeys('worker-secret-for-tests', 'inbox-b', storage).load('npm'), /does not decrypt/);
    await assert.rejects(sealedOtpKeys('another-secret', 'inbox-a', storage).load('npm'), /does not decrypt/);
    // A redemption over a key that no longer decrypts refuses with the reason, and sends no code.
    const inbox = new Inbox(new MemoryStorage(), () => NOW, undefined, { otpKeys: sealedOtpKeys('worker-secret-for-tests', 'inbox-a', storage) });
    await inbox.otpEnroll(owner, 'npm', { key: KEY_TEXT, code: await totp(RFC_KEY, NOW), allow: [SESSION] });
    const session = await newSealKeys();
    post(inbox, session.publicKey);
    const answer = await inbox.answer('c1', { values: { NPM_OTP: 'approve' }, by: owner });
    const sealed = storage.get<{ iv: string; data: string }>('otpsealed', 'npm')!;
    storage.put('otpsealed', 'npm', { ...sealed, data: `${sealed.data.startsWith('A') ? 'B' : 'A'}${sealed.data.slice(1)}` });
    await assert.rejects(inbox.otpRedeem(agent, { ticket: (answer.values['NPM_OTP'] as OtpApproval).ticket, agent: SESSION }), rejects(500, /the key npm is damaged: its ciphertext does not decrypt/));
  });
});

/** The part of the client a card tool uses, over the inbox in this process, as the agent token. */
function clientOver(inbox: Inbox): Client {
  return {
    post: async (card: NewCard) => ({ ...inbox.postCard(agent, card), inheritedTags: [], openCards: { total: 0, cards: [] } }),
    secretLookup: async () => ({ candidates: [], sources: [] }),
    otpRedeem: (ticket: string, who: string) => inbox.otpRedeem(agent, { ticket, agent: who }),
  } as unknown as Client;
}
