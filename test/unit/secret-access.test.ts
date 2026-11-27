// The secret_access widget on the inbox side: the lookup routes, the card that asks, the release inside the owner's
// answer, and revocation. SPEC.md#secret-sources holds the contract. A stand-in SecretSources plays the laptop's sources.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAnswer } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { DEFAULT_GUIDANCE, Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { GRANT_MAX_MS, type Candidate, type SecretQuery, type SecretSources, type SourceInfo } from '../../src/core/secret-sources.ts';
import { isSealed, newSealKeys, openSealed, secretAccesses } from '../../src/core/sealed.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AccessGrant } from '../../src/core/secret-sources.ts';
import type { AgentEvent, Answer, Card, NewCard } from '../../src/core/types.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import type { Client } from '../../src/client.ts';
import { sealValue } from '../../src/core/sealed.ts';

const agent: Caller = { token: 'ta', role: 'agent' };
const owner: Caller = { token: 'to', role: 'owner' };
const extension: Caller = { token: 'te', role: 'extension' };
const NOW = 1_800_000_000_000;

const SOURCES: SourceInfo[] = [{ instance: 'laptop', name: 'age', builtin: true, status: 'ready' }];
const DB: Candidate = { id: 'db-staging', label: 'Staging database', source: 'age', instance: 'laptop', type: 'file' };

/** A stand-in for the laptop's sources: one `age` source that holds made-up values, and records each release. */
function standIn(values: Record<string, string> = { 'db-staging': 'postgres://demo:not-real@localhost/demo' }) {
  const released: { source: string; candidate: string }[] = [];
  const queries: SecretQuery[] = [];
  const sources: SecretSources = {
    list: async () => SOURCES,
    lookup: async (q) => {
      queries.push(q);
      return { candidates: q.name === 'DATABASE_URL' ? [DB] : [], sources: SOURCES };
    },
    release: async (source, candidate, publicKey) => {
      released.push({ source, candidate });
      const v = values[candidate];
      if (v === undefined) throw new Error('the item is gone from the folder');
      return sealValue(publicKey, v);
    },
  };
  return { sources, released, queries };
}

async function setup(values?: Record<string, string>) {
  const s = standIn(values);
  const inbox = new Inbox(new MemoryStorage(), () => NOW, undefined, { secretSources: s.sources });
  const keys = await newSealKeys();
  return { inbox, keys, ...s };
}

/** A body that places secret_access as card_post fills it. */
function accessBody(publicKey: JsonWebKey, candidates: unknown[] = [DB], name = 'DATABASE_URL'): string {
  return `root = Card([intro, db])\nintro = TextContent("To run the migration.")\ndb = widget secret_access ${JSON.stringify({ name, publicKey: JSON.stringify(publicKey), candidates: JSON.stringify(candidates) })}`;
}

const grant = (until = NOW + 3_600_000) => ({ grant: 'db-staging', source: 'age', instance: 'laptop', until });
const rejects = (status: number, message: RegExp) => (e: unknown): boolean => e instanceof InboxError && e.status === status && message.test(e.message);

/** Call the HTTP handler as one role. */
async function call(inbox: Inbox, role: 'owner' | 'agent' | 'extension', method: string, route: string, body?: unknown): Promise<Response> {
  const { secret } = await inbox.createToken(role, role);
  const handle = createHandler(inbox);
  return handle(new Request(`http://inbox.test${route}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
}

describe('the secret lookup routes', () => {
  it('answers candidates as metadata only, for an agent or the owner', async () => {
    const { inbox } = await setup();
    for (const role of ['agent', 'owner'] as const) {
      const res = await call(inbox, role, 'POST', '/v1/secrets/lookup', { name: 'DATABASE_URL' });
      assert.equal(res.status, 200);
      const got = await res.json() as { candidates: Candidate[]; sources: SourceInfo[] };
      assert.deepEqual(got, { candidates: [DB], sources: SOURCES });
      assert.doesNotMatch(JSON.stringify(got), /postgres:/);
    }
    const listed = await call(inbox, 'agent', 'GET', '/v1/secrets/sources');
    assert.deepEqual(await listed.json(), { sources: SOURCES });
  });

  it('refuses an extension token, and a query field that is not text', async () => {
    const { inbox } = await setup();
    assert.equal((await call(inbox, 'extension', 'POST', '/v1/secrets/lookup', { name: 'X' })).status, 403);
    assert.equal((await call(inbox, 'extension', 'GET', '/v1/secrets/sources')).status, 403);
    assert.equal((await call(inbox, 'agent', 'POST', '/v1/secrets/lookup', { name: 5 })).status, 400);
  });

  it('answers empty lists on an inbox with no sources, as the hosted inbox has', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const res = await call(inbox, 'agent', 'POST', '/v1/secrets/lookup', { name: 'DATABASE_URL' });
    assert.deepEqual(await res.json(), { candidates: [], sources: [] });
    assert.deepEqual(await (await call(inbox, 'agent', 'GET', '/v1/secrets/sources')).json(), { sources: [] });
  });
});

describe('the secret_access widget', () => {
  it('is a built-in widget whose when text says card_post fills it', () => {
    const inbox = new Inbox(new MemoryStorage());
    assert.ok(inbox.listWidgets().some((w) => w.name === 'secret_access' && w.builtin));
    assert.match(inbox.widgetCatalog(), /- secret_access: .*card_post/);
    assert.match(DEFAULT_GUIDANCE, /widget secret_access \{"name": "DATABASE_URL", "query"/);
  });

  it('places a SecretAccess field, and the card names it among its secrets', async () => {
    const { inbox, keys } = await setup();
    const card = inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    assert.match(card.body ?? '', /SecretAccess\("DATABASE_URL", "\{/);
    assert.deepEqual(card.secrets, ['DATABASE_URL']);
    const [field] = secretAccesses(card.body ?? '');
    assert.equal(field?.name, 'DATABASE_URL');
    assert.deepEqual(field?.candidates, [DB]);
  });

  it('refuses candidates that are not a JSON list of objects with id, source, instance and label', async () => {
    const { inbox, keys } = await setup();
    for (const bad of [[{ id: 'x', source: 'age', instance: 'laptop' }], [{ ...DB, id: 5 }], ['db']]) {
      assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Database?', body: accessBody(keys.publicKey, bad) }), rejects(400, /candidates/));
    }
    const notJson = `root = Card([db])\ndb = widget secret_access ${JSON.stringify({ name: 'DATABASE_URL', publicKey: JSON.stringify(keys.publicKey), candidates: '{' })}`;
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Database?', body: notJson }), rejects(400, /candidates/));
    // The same 400s as SecretInput.
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Database?', body: `root = Card([db])\ndb = widget secret_access {"name": "DATABASE_URL", "candidates": "[]"}` }), /needs the public key.*card_post/);
  });

  it('keeps fields beyond the four it checks, such as a status the lookup gave', async () => {
    const { inbox, keys } = await setup();
    const extra = { ...DB, status: 'off', reason: 'no identity file' };
    const card = inbox.postCard(agent, { agent: 's1', title: 'Database?', body: accessBody(keys.publicKey, [extra]) });
    assert.deepEqual(secretAccesses(card.body ?? '')[0]?.candidates, [extra]);
  });
});

describe('granting a secret_access field', () => {
  it('stores the value the source sealed to the card key, which opens with the private key', async () => {
    const { inbox, keys, released } = await setup();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    const answer = await inbox.answer('a1', { values: { DATABASE_URL: grant() } });
    const v = answer.values['DATABASE_URL'] as AccessGrant;
    assert.deepEqual(released, [{ source: 'age', candidate: 'db-staging' }]);
    assert.equal(v.grant, 'db-staging');
    assert.equal(v.until, NOW + 3_600_000);
    assert.match(v.case, /^[a-z0-9]{6,12}$/);
    assert.ok(isSealed(v.sealed));
    assert.equal(await openSealed(keys.privateKey, v.sealed), 'postgres://demo:not-real@localhost/demo');
  });

  it('caps the ceiling at 24 hours after the answer, and refuses one already past', async () => {
    const { inbox, keys } = await setup();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    const answer = await inbox.answer('a1', { values: { DATABASE_URL: grant(NOW + 7 * GRANT_MAX_MS) } });
    assert.equal((answer.values['DATABASE_URL'] as AccessGrant).until, NOW + GRANT_MAX_MS);
    await assert.rejects(inbox.answer('a1', { values: { DATABASE_URL: grant(NOW - 1) } }), rejects(400, /until/));
  });

  it('refuses a candidate the card does not list, and releases nothing', async () => {
    const { inbox, keys, released } = await setup({ 'db-staging': 'x', 'db-prod': 'y' });
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    await assert.rejects(inbox.answer('a1', { values: { DATABASE_URL: { ...grant(), grant: 'db-prod' } } }), rejects(400, /not one the card offers/));
    await assert.rejects(inbox.answer('a1', { values: { DATABASE_URL: { ...grant(), instance: 'other' } } }), rejects(400, /not one the card offers/));
    assert.deepEqual(released, []);
    assert.equal(inbox.cardDetail('a1', true).answer, undefined);
  });

  it('fails the whole answer with 502 and the source sentence when the source refuses', async () => {
    const { inbox, keys } = await setup({});
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    await assert.rejects(inbox.answer('a1', { values: { DATABASE_URL: grant(), note: 'go' } }), rejects(502, /the item is gone from the folder/));
    assert.equal(inbox.cardDetail('a1', true).answer, undefined);
  });

  it('answers 502 on an inbox with no sources', async () => {
    const inbox = new Inbox(new MemoryStorage(), () => NOW);
    const keys = await newSealKeys();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    await assert.rejects(inbox.answer('a1', { values: { DATABASE_URL: grant() } }), rejects(502, /no secret sources/));
  });

  it('stores a decline as is, with no value and no grant, and an untouched field reads as declined', async () => {
    const { inbox, keys, released } = await setup();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    const answer = await inbox.answer('a1', { values: { DATABASE_URL: { decline: true } } });
    assert.deepEqual(answer.values['DATABASE_URL'], { decline: true });
    assert.deepEqual(released, []);
    const card = inbox.getCard('a1');
    assert.equal(describeAnswer(card, answer), 'DATABASE_URL: declined');
    const untouched = await inbox.answer('a1', { values: {} });
    assert.equal(untouched.values['DATABASE_URL'], undefined);
    assert.equal(describeAnswer(card, untouched), 'DATABASE_URL: declined');
  });

  it('takes a value the person typed and sealed, as the secret widget does, and refuses plain text or another shape', async () => {
    const { inbox, keys, released } = await setup();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    const typed = await sealValue(keys.publicKey, 'typed-not-real');
    const answer = await inbox.answer('a1', { values: { DATABASE_URL: typed } });
    assert.deepEqual(answer.values['DATABASE_URL'], typed);
    assert.deepEqual(released, []);
    await assert.rejects(inbox.answer('a1', { values: { DATABASE_URL: 'postgres://plain' } }), rejects(400, /DATABASE_URL/));
    await assert.rejects(inbox.answer('a1', { values: { DATABASE_URL: { grant: 'db-staging' } } }), rejects(400, /DATABASE_URL/));
  });

  it('tells the agent the case and the ceiling, never a value', async () => {
    const { inbox, keys } = await setup();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    const answer = await inbox.answer('a1', { values: { DATABASE_URL: grant() } });
    const v = answer.values['DATABASE_URL'] as AccessGrant;
    const text = describeAnswer(inbox.getCard('a1'), answer);
    assert.equal(text, `DATABASE_URL: granted (case ${v.case}, until ${new Date(v.until).toISOString()})`);
    assert.doesNotMatch(text, /A256GCM|postgres/);
  });

  it('sends hooks and webhooks the answer without the grant, and the agent stream all of it', async () => {
    const sent: string[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body)); return new Response(null, { status: 200 }); }) as typeof fetch;
    const s = standIn();
    const inbox = new Inbox(new MemoryStorage(), () => NOW, undefined, { secretSources: s.sources, fetch: fetcher });
    const keys = await newSealKeys();
    const hooks: { hook?: string; answer?: Answer }[] = [];
    inbox.connectExtension(extension, { name: 'watch', hooks: ['answer.saved'] }, (ev) => hooks.push(ev as never));
    const sub = inbox.subscribe(agent, { agent: 's1', kind: 'system', title: 'Subscribe', system: { type: 'subscribe', webhook: { url: 'https://example.com/hooks/abc', headers: {} }, events: ['answer'] } } as NewCard);
    await inbox.answer(sub.card.id, { values: { choice: 'approve' } });
    const heard: AgentEvent[] = [];
    inbox.connect(agent, 's1', (ev) => heard.push(ev));
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    await inbox.answer('a1', { values: { DATABASE_URL: grant(), note: 'n' } });
    while (inbox.deliveries.size) await Promise.all([...inbox.deliveries]);
    const hook = hooks.find((e) => e.hook === 'answer.saved');
    assert.deepEqual(hook?.answer?.values, { note: 'n' });
    assert.ok(sent.length >= 1);
    // The card names its candidates, which are metadata. The answer names neither the grant nor the sealed value.
    for (const body of sent) {
      const ev = JSON.parse(body) as { answer?: Answer };
      if (ev.answer?.card === 'a1') assert.deepEqual(ev.answer.values, { note: 'n' });
      assert.doesNotMatch(body, /A256GCM/);
    }
    assert.ok(sent.some((b) => (JSON.parse(b) as { answer?: Answer }).answer?.card === 'a1'));
    const ev = heard.find((e) => e.type === 'answer');
    assert.ok(ev?.type === 'answer' && isSealed((ev.answer.values['DATABASE_URL'] as AccessGrant).sealed));
  });

  it('refuses an agent token on the answer route, with 403', async () => {
    const { inbox, keys, released } = await setup();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    for (const role of ['agent', 'extension'] as const) {
      const res = await call(inbox, role, 'POST', '/v1/cards/a1/answer', { values: { DATABASE_URL: grant() } });
      assert.equal(res.status, 403);
    }
    assert.deepEqual(released, []);
  });

  it('answers 502 with the source sentence on the answer route', async () => {
    const { inbox, keys } = await setup({});
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(keys.publicKey) });
    const res = await call(inbox, 'owner', 'POST', '/v1/cards/a1/answer', { values: { DATABASE_URL: grant() } });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /the item is gone from the folder/);
  });
});

describe('revoking a grant', () => {
  async function granted() {
    const s = await setup();
    s.inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'Database?', body: accessBody(s.keys.publicKey) });
    const heard: AgentEvent[] = [];
    s.inbox.connect(agent, 's1', (ev) => heard.push(ev));
    const answer = await s.inbox.answer('a1', { values: { DATABASE_URL: grant() } });
    return { ...s, heard, granted: answer.values['DATABASE_URL'] as AccessGrant };
  }

  it('records revokedAt and tells the agent stream, with the case', async () => {
    const { inbox, heard, granted: g } = await granted();
    const res = await call(inbox, 'owner', 'POST', '/v1/cards/a1/revoke', { field: 'DATABASE_URL' });
    assert.equal(res.status, 200);
    const stored = inbox.cardDetail('a1', true).answer?.values['DATABASE_URL'] as AccessGrant;
    assert.equal(stored.revokedAt, NOW);
    const ev = heard.find((e) => e.type === 'revoke');
    assert.ok(ev && ev.type === 'revoke');
    assert.equal(ev.card.id, 'a1');
    assert.equal(ev.field, 'DATABASE_URL');
    assert.equal(ev.case, g.case);
  });

  it('refuses an agent or extension token with 403', async () => {
    const { inbox, heard } = await granted();
    for (const role of ['agent', 'extension'] as const) assert.equal((await call(inbox, role, 'POST', '/v1/cards/a1/revoke', { field: 'DATABASE_URL' })).status, 403);
    assert.ok(!heard.some((e) => e.type === 'revoke'));
  });

  it('refuses a field with no grant', async () => {
    const { inbox } = await granted();
    assert.throws(() => inbox.revokeGrant(owner, 'a1', 'OTHER'), rejects(409, /no grant/));
  });
});

describe('card_post fills secret_access', () => {
  it('runs the lookup for each placement without candidates, and fills candidates and the card public key', async () => {
    const { inbox, queries } = await setup();
    const client = {
      post: async (c: NewCard) => inbox.postCard(agent, c),
      secretLookup: (q: SecretQuery) => inbox.secretLookup(agent, q),
    } as unknown as Client;
    const secrets = new SecretRequests();
    const ctx = { inbox: client, secrets, agent: 's1', origin: async () => undefined, arrival: 'later' };
    const kept = { ...DB, id: 'kept', label: 'Given by the agent' };
    const body = `root = Card([db, other])\ndb = widget secret_access {"name": "DATABASE_URL", "query": {"name": "DATABASE_URL"}}\nother = widget secret_access ${JSON.stringify({ name: 'OTHER', candidates: [kept] })}`;
    await runTool(ctx, 'card_post', { id: 'a1', title: 'Database?', body });
    assert.deepEqual(queries, [{ name: 'DATABASE_URL' }]);
    const card: Card = inbox.getCard('a1');
    const fields = secretAccesses(card.body ?? '');
    assert.deepEqual(fields.map((f) => f.candidates), [[DB], [kept]]);
    // One key pair per card: the secret widget and secret_access seal to the same key.
    assert.equal(fields[0]?.publicKey, fields[1]?.publicKey);
    assert.ok(!('d' in JSON.parse(fields[0]!.publicKey)));
  });
});
