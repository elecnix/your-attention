// Tagging a card that is already posted: POST /v1/cards/<id>/tags (SPEC.md, "Editing cards").
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { CardSummary } from '../../src/core/summary.ts';
import type { Card } from '../../src/core/types.ts';

async function setup() {
  const inbox = new Inbox(new MemoryStorage(), () => 1_000);
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const owner = (await inbox.createToken('page', 'owner')).secret;
  const agentA = (await inbox.createToken('agent a', 'agent')).secret;
  const agentB = (await inbox.createToken('agent b', 'agent')).secret;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> =>
    handle(new Request(`http://inbox.test${path}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }));
  const post = async (token: string, body: Record<string, unknown>): Promise<Card> =>
    (await (await call('POST', '/v1/cards', { token, body: { agent: 's1', ...body } })).json()) as Card;
  return { call, post, owner, agentA, agentB };
}

const tag = (call: (method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<Response>, token: string, id: string, tags: Record<string, string>) =>
  call('POST', `/v1/cards/${id}/tags`, { token, body: { tags } });

describe('tagging a card that is already posted', () => {
  it('gives a card with no tags its first one, and a search finds it by that tag at once', async () => {
    const { call, post, agentA } = await setup();
    const posted = await post(agentA, { id: 'c1', title: 'Ship the queue' });
    assert.equal(posted.tags, undefined);
    const res = await tag(call, agentA, 'c1', { topic: 'billing' });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as Card).tags, { topic: 'billing' });
    const hits = (await (await call('GET', '/v1/search?q=billing', { token: agentA })).json()) as { card: Card }[];
    assert.deepEqual(hits.map((h) => h.card.id), ['c1']);
  });

  it('merges into the tags the card carries without dropping one', async () => {
    const { call, post, agentA } = await setup();
    await post(agentA, { id: 'c1', title: 'q', tags: { repo: 'acme/api', topic: 'billing' } });
    const merged = (await (await tag(call, agentA, 'c1', { owner: 'nicolas' })).json()) as Card;
    assert.deepEqual(merged.tags, { repo: 'acme/api', topic: 'billing', owner: 'nicolas' });
  });

  it('removes a key whose value is empty, and the search stops finding it', async () => {
    const { call, post, agentA } = await setup();
    await post(agentA, { id: 'c1', title: 'q', tags: { repo: 'acme/api', topic: 'billing' } });
    const removed = (await (await tag(call, agentA, 'c1', { topic: '' })).json()) as Card;
    assert.deepEqual(removed.tags, { repo: 'acme/api' });
    const hits = (await (await call('GET', '/v1/search?q=billing', { token: agentA })).json()) as { card: Card }[];
    assert.deepEqual(hits, []);
  });

  it('answers 403 to an agent that does not own the card, and lets the owner change it', async () => {
    const { call, post, owner, agentA, agentB } = await setup();
    await post(agentA, { id: 'c1', title: 'q' });
    const denied = await tag(call, agentB, 'c1', { topic: 'billing' });
    assert.equal(denied.status, 403);
    assert.match(((await denied.json()) as { error: string }).error, /another client owns this card/);
    const byOwner = await tag(call, owner, 'c1', { topic: 'billing' });
    assert.equal(byOwner.status, 200);
    assert.deepEqual(((await byOwner.json()) as Card).tags, { topic: 'billing' });
  });

  it('answers 400 with the key when one is past a card\'s tag limit', async () => {
    const { call, post, agentA } = await setup();
    await post(agentA, { id: 'c1', title: 'q' });
    const longKey = 'k'.repeat(101);
    const keyRes = await tag(call, agentA, 'c1', { [longKey]: 'v' });
    assert.equal(keyRes.status, 400);
    const keyError = ((await keyRes.json()) as { error: string }).error;
    assert.match(keyError, /must be at most 100 characters/);
    assert.match(keyError, /kkkkkkkkkk/, 'the message names the key');
    const valueRes = await tag(call, agentA, 'c1', { topic: 'v'.repeat(101) });
    assert.equal(valueRes.status, 400);
    const valueError = ((await valueRes.json()) as { error: string }).error;
    assert.match(valueError, /must be at most 100 characters/);
    assert.match(valueError, /topic/, 'the message names the key');
    // A card keeps at most 10 tags, and the key that takes it past them is the one the message names.
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
    const countRes = await tag(call, agentA, 'c1', eleven);
    assert.equal(countRes.status, 400);
    assert.match(((await countRes.json()) as { error: string }).error, /k10.*past its 10 tags/);
  });

  it('carries the new tags to the page in GET /v1/state', async () => {
    const { call, post, owner, agentA } = await setup();
    await post(agentA, { id: 'c1', title: 'q' });
    await tag(call, agentA, 'c1', { topic: 'billing' });
    const state = (await (await call('GET', '/v1/state', { token: owner })).json()) as { cards: CardSummary[] };
    assert.deepEqual(state.cards.find((c) => c.id === 'c1')?.tags, { topic: 'billing' });
  });

  it('leaves the session\'s default tags alone', async () => {
    const { call, post, agentA } = await setup();
    await call('PUT', '/v1/tags', { token: agentA, body: { agent: 's1', tags: { repo: 'acme/api' } } });
    const posted = await post(agentA, { id: 'c1', title: 'q' });
    assert.deepEqual(posted.tags, { repo: 'acme/api' });
    await tag(call, agentA, 'c1', { repo: 'acme/web' });
    const defaults = (await (await call('GET', '/v1/tags?agent=s1', { token: agentA })).json()) as { tags: Record<string, { value: string }> };
    assert.equal(defaults.tags['repo']?.value, 'acme/api');
  });
});

describe('the card_tag tool', () => {
  it('names the tags the card carries after the change, and says when it carries none', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const ctx = (card: { id: string; tags?: Record<string, string> }) => ({ inbox: { tag: async () => card } as never, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' });
    const tagged = await runTool(ctx({ id: 'c9', tags: { repo: 'acme/api', topic: 'billing' } }), 'card_tag', { card_id: 'c9', tags: { topic: 'billing' } });
    assert.match(tagged, /Card c9 now carries the tags repo: acme\/api, topic: billing\./);
    const empty = await runTool(ctx({ id: 'c9' }), 'card_tag', { card_id: 'c9', tags: { topic: '' } });
    assert.match(empty, /Card c9 now carries no tags\./);
  });
});
