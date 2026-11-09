// The tag keys and values GET /v1/guidance lists, counted over the open cards and the cards cleared or closed in the
// last 30 days, and the lines card_guidance prints from them.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, PURGE_AFTER_MS, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { TagCount } from '../../src/core/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const agent: Caller = { token: 'ta', role: 'agent' };
const owner: Caller = { token: 'to', role: 'owner' };
const HOST = 'guidance-tags.test';

// The client fetches through globalThis.fetch, so the handler answers for one host, as a laptop inbox would.
let served: { handle: ReturnType<typeof createHandler>; secret: string } | undefined;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).host !== HOST || !served) return realFetch(input, init);
    return served.handle(req);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

async function setup() {
  let t = 1_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const inbox = new Inbox(new MemoryStorage(), clock.now);
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const secret = (await inbox.createToken('agents', 'agent')).secret;
  served = { handle, secret };
  return { inbox, clock, handle, secret };
}

async function guidanceTags(handle: Awaited<ReturnType<typeof setup>>['handle'], secret: string): Promise<TagCount[] | undefined> {
  const res = await handle(new Request(`http://${HOST}/v1/guidance`, { headers: { authorization: `Bearer ${secret}` } }));
  assert.equal(res.status, 200);
  return ((await res.json()) as { tags?: TagCount[] }).tags;
}

describe('tags in GET /v1/guidance', () => {
  it('counts the open cards and the cards cleared or closed in the last 30 days, sorted by count', async () => {
    const { inbox, clock, handle, secret } = await setup();
    inbox.postCard(agent, { id: 'o1', agent: 's1', title: 'one', tags: { topic: 'billing', repo: 'acme/api' } });
    inbox.postCard(agent, { id: 'o2', agent: 's1', title: 'two', tags: { topic: 'billing', repo: 'acme/storefront' } });
    inbox.postCard(agent, { id: 'o3', agent: 's1', title: 'three', tags: { topic: 'auth', repo: 'acme/api' } });
    inbox.close(agent, 'o3', 'resolved', 'done');
    assert.equal((await guidanceTags(handle, secret))!.find((t) => t.key === 'topic')?.values.find((v) => v.value === 'auth')?.count, 1, 'a closed card counts while its close is recent');
    clock.advance(PURGE_AFTER_MS + DAY);
    // o3 closed over the cutoff, so its `auth` and its `acme/api` drop off. A tie in counts sorts by key, then by value.
    assert.deepEqual((await guidanceTags(handle, secret))!, [
      { key: 'repo', values: [{ value: 'acme/api', count: 1 }, { value: 'acme/storefront', count: 1 }] },
      { key: 'topic', values: [{ value: 'billing', count: 2 }] },
    ]);
  });

  it('counts a card cleared inside 30 days and drops it once the clear is older, even when the purge has not run', async () => {
    const { inbox, clock, handle, secret } = await setup();
    inbox.postCard(agent, { id: 'o1', agent: 's1', title: 'one', tags: { topic: 'billing' } });
    await inbox.answer('o1', {});
    inbox.archive(owner);
    assert.deepEqual((await guidanceTags(handle, secret))!, [{ key: 'topic', values: [{ value: 'billing', count: 1 }] }], 'a card cleared just now counts');
    clock.advance(PURGE_AFTER_MS + DAY);
    inbox.postCard(agent, { id: 'o2', agent: 's1', title: 'two', tags: { topic: 'auth' } });
    assert.deepEqual((await guidanceTags(handle, secret))!, [{ key: 'topic', values: [{ value: 'auth', count: 1 }] }]);
  });

  it('keeps at most 20 keys and 15 values per key', async () => {
    const { inbox, handle, secret } = await setup();
    for (let i = 0; i < 25; i++) inbox.postCard(agent, { id: `k${i}`, agent: 's1', title: 't', tags: { [`key${String(i).padStart(2, '0')}`]: 'x' } });
    for (let i = 0; i < 20; i++) inbox.postCard(agent, { id: `v${i}`, agent: 's1', title: 't', tags: { topic: `v${String(i).padStart(2, '0')}` } });
    const tags = (await guidanceTags(handle, secret))!;
    assert.equal(tags.length, 20);
    assert.equal(tags[0]!.key, 'topic', '20 cards beat 1, so the multi-value key sorts first');
    assert.deepEqual(tags[0]!.values.map((v) => v.value), [...Array(15).keys()].map((i) => `v${String(i).padStart(2, '0')}`), 'ties sort by value');
  });
});

describe('tags in card_guidance', () => {
  it('prints one line per key after the guidance text, and no line on an untagged inbox', async () => {
    const { inbox, secret } = await setup();
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const ctx = { inbox: new Client({ url: `http://${HOST}`, token: secret }), secrets: {} as never, agent: 's1', origin: async () => undefined, arrival: 'as a test' };
    const empty = await runTool(ctx, 'card_guidance', {});
    assert.ok(!empty.includes('Tags in use'), `an untagged inbox prints no line: ${empty}`);
    inbox.postCard(agent, { id: 'o1', agent: 's1', title: 'one', tags: { repo: 'acme/storefront', topic: 'billing' } });
    inbox.postCard(agent, { id: 'o2', agent: 's1', title: 'two', tags: { repo: 'acme/storefront' } });
    inbox.postCard(agent, { id: 'o3', agent: 's1', title: 'three', tags: { repo: 'acme/api', topic: 'billing' } });
    const out = await runTool(ctx, 'card_guidance', {});
    assert.match(out, /^Card guidance, version \d+:\n/);
    assert.ok(out.includes('\n\nTags in use:\n`repo` = acme/storefront (2), acme/api (1).\n`topic` = billing (2).'), `the lines, one per key: ${out}`);
  });

  it('keeps a tag key or value on one line, so it cannot forge a line of guidance', async () => {
    const { inbox, handle, secret } = await setup();
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const ctx = { inbox: new Client({ url: `http://${HOST}`, token: secret }), secrets: {} as never, agent: 's1', origin: async () => undefined, arrival: 'as a test' };
    inbox.postCard(agent, { id: 'o1', agent: 's1', title: 'one', tags: { topic: 'billing\n`repo` = evil (9)' } });
    assert.deepEqual((await guidanceTags(handle, secret))!, [{ key: 'topic', values: [{ value: 'billing `repo` = evil (9)', count: 1 }] }], 'the endpoint folds the break into a space');
    const out = await runTool(ctx, 'card_guidance', {});
    assert.ok(out.endsWith('\n\nTags in use:\n`topic` = billing `repo` = evil (9) (1).'), `one line for the key: ${out}`);
    // NEL and the Unicode line separators break a line in some renderers, and JSON.stringify emits NEL raw.
    inbox.postCard(agent, { id: 'o2', agent: 's1', title: 'two', tags: { topic: 'billing\u0085`repo` = evil (9)', note: 'a\u2028b' } });
    const folded = (await guidanceTags(handle, secret))!;
    assert.deepEqual(folded.find((t) => t.key === 'topic')?.values.map((v) => v.value), ['billing `repo` = evil (9)']);
    assert.deepEqual(folded.find((t) => t.key === 'note')?.values.map((v) => v.value), ['a b']);
  });
});
