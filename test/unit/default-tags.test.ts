// Default tags: the per-agent tags that every card it posts inherits (SPEC.md, "Default tags").
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, mergeDefaultTags, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { DefaultTags } from '../../src/core/types.ts';

const caller: Caller = { token: 'ta', role: 'agent' };
const other: Caller = { token: 'tb', role: 'agent' };
const ownerCaller: Caller = { token: 'to', role: 'owner' };

const fresh = (store = new MemoryStorage()) => new Inbox(store);

describe('default tags', () => {
  it('sets, merges, removes and clears the caller\'s defaults, and reads them back with what set them', () => {
    const inbox = fresh();
    let d = inbox.setDefaultTags(caller, { agent: 's1', tags: { repo: 'acme/api' } });
    assert.deepEqual(d, { agent: 's1', tags: { repo: { value: 'acme/api', from: 'card_tags' } } });
    // A second call merges: the first key keeps its value and its origin.
    d = inbox.setDefaultTags(caller, { agent: 's1', tags: { topic: 'billing' }, from: 'YOUR_ATTENTION_TAGS' });
    assert.deepEqual(d.tags, { repo: { value: 'acme/api', from: 'card_tags' }, topic: { value: 'billing', from: 'YOUR_ATTENTION_TAGS' } });
    d = inbox.setDefaultTags(caller, { agent: 's1', remove: ['topic'] });
    assert.deepEqual(d.tags, { repo: { value: 'acme/api', from: 'card_tags' } });
    d = inbox.setDefaultTags(caller, { agent: 's1', clear: true });
    assert.deepEqual(d.tags, {});
    assert.deepEqual(inbox.defaultTags(caller, 's1').tags, {});
  });

  it('follows the card tag limits: at most 10 keys, each key and value at most 100 characters', () => {
    const inbox = fresh();
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v']));
    inbox.setDefaultTags(caller, { agent: 's1', tags: ten });
    assert.throws(() => inbox.setDefaultTags(caller, { agent: 's1', tags: { k10: 'v' } }), /at most 10/);
    assert.throws(() => inbox.setDefaultTags(caller, { agent: 's1', clear: true, tags: { ['k'.repeat(101)]: 'v' } }), /at most 100/);
    assert.throws(() => inbox.setDefaultTags(caller, { agent: 's1', clear: true, tags: { a: 'v'.repeat(101) } }), /at most 100/);
    assert.throws(() => inbox.setDefaultTags(caller, { agent: 's1', clear: true, tags: { '': 'v' } }), /key/);
    assert.throws(() => inbox.setDefaultTags(caller, { agent: 's1', clear: true, tags: { a: '' } }), /empty/);
    assert.throws(() => inbox.setDefaultTags(caller, { agent: '', tags: { a: 'b' } }), /agent is required/);
    assert.throws(() => inbox.setDefaultTags({ token: 'te', role: 'extension' }, { agent: 's1', tags: { a: 'b' } }), /only an agent/);
  });

  it('puts the defaults under the card\'s own tags: the card wins, and an empty value drops the default on that card', () => {
    const inbox = fresh();
    inbox.setDefaultTags(caller, { agent: 's1', tags: { repo: 'acme/api', topic: 'billing' } });
    const plain = inbox.postCard(caller, { id: 'c1', agent: 's1', title: 'q' });
    assert.deepEqual(plain.tags, { repo: 'acme/api', topic: 'billing' });
    const own = inbox.postCard(caller, { id: 'c2', agent: 's1', title: 'q', tags: { topic: 'ops' } });
    assert.deepEqual(own.tags, { repo: 'acme/api', topic: 'ops' });
    const dropped = inbox.postCard(caller, { id: 'c3', agent: 's1', title: 'q', tags: { topic: '' } });
    assert.deepEqual(dropped.tags, { repo: 'acme/api' });
  });

  it('never applies them to the inbox\'s own system cards', () => {
    const inbox = fresh();
    inbox.setDefaultTags(caller, { agent: 's1', tags: { repo: 'acme/api' } });
    const system = inbox.postCard({ token: '', role: 'owner' }, { id: 'sys1', agent: 'system', kind: 'system', title: 'q', deliver: 'none' });
    assert.equal(system.tags, undefined);
  });

  it('keeps another agent\'s defaults away, and another token\'s too', () => {
    const inbox = fresh();
    inbox.setDefaultTags(caller, { agent: 's1', tags: { repo: 'acme/api' } });
    // Another agent id has no defaults.
    assert.deepEqual(inbox.defaultTags(caller, 's2').tags, {});
    assert.equal(inbox.postCard(caller, { id: 'c1', agent: 's2', title: 'q' }).tags, undefined);
    // Another token, even for the same agent id, has its own defaults.
    assert.deepEqual(inbox.defaultTags(other, 's1').tags, {});
    inbox.setDefaultTags(other, { agent: 's1', tags: { repo: 'other/repo' } });
    assert.deepEqual(inbox.defaultTags(caller, 's1').tags, { repo: { value: 'acme/api', from: 'card_tags' } });
    assert.equal(inbox.postCard(other, { id: 'c2', agent: 's1', title: 'q' }).tags?.['repo'], 'other/repo');
  });

  it('lets the owner list them per agent and token, and only the owner gets that list', () => {
    const inbox = fresh();
    inbox.setDefaultTags(caller, { agent: 's1', tags: { repo: 'acme/api' } });
    inbox.setDefaultTags(other, { agent: 's2', tags: { topic: 'ops' } });
    assert.deepEqual(inbox.defaultTagsList(ownerCaller), [
      { token: 'ta', agent: 's1', tags: { repo: { value: 'acme/api', from: 'card_tags' } } },
      { token: 'tb', agent: 's2', tags: { topic: { value: 'ops', from: 'card_tags' } } },
    ]);
    assert.deepEqual(inbox.defaultTagsList(ownerCaller, 's2'), [{ token: 'tb', agent: 's2', tags: { topic: { value: 'ops', from: 'card_tags' } } }]);
    assert.throws(() => inbox.defaultTagsList(caller), /only the owner/);
  });

  it('keeps the defaults when the inbox restarts, in storage and not in memory', () => {
    const store = new MemoryStorage();
    const first = new Inbox(store);
    first.setDefaultTags(caller, { agent: 's1', tags: { repo: 'acme/api', topic: 'billing' } });
    const second = new Inbox(store);
    assert.deepEqual(second.defaultTags(caller, 's1').tags, {
      repo: { value: 'acme/api', from: 'card_tags' },
      topic: { value: 'billing', from: 'card_tags' },
    });
    assert.equal(second.postCard(caller, { id: 'c1', agent: 's1', title: 'q' }).tags?.['repo'], 'acme/api');
  });

  it('keeps a patch from resurrecting a default the card dropped, and from adding one set later', () => {
    const inbox = fresh();
    inbox.setDefaultTags(caller, { agent: 's1', tags: { topic: 'billing' } });
    inbox.postCard(caller, { id: 'c1', agent: 's1', title: 'q', text: 'one', tags: { topic: '' } });
    inbox.setDefaultTags(caller, { agent: 's1', tags: { repo: 'acme/api' } });
    const patched = inbox.patchCard(caller, 'c1', [{ old: 'one', new: 'two' }]);
    assert.equal(patched.tags, undefined);
  });

  it('drops defaults past the 10-key limit of the merged tags, keeping the card\'s own', () => {
    const defaults = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${i}`, 'v']));
    const { tags, inherited } = mergeDefaultTags(defaults, { own: 'x' });
    assert.equal(Object.keys(tags ?? {}).length, 10);
    assert.equal(tags?.['own'], 'x');
    assert.equal(inherited.length, 9, 'one default loses to the card\'s own key');
  });
});

async function httpSetup() {
  const inbox = fresh();
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const owner = (await inbox.createToken('page', 'owner')).secret;
  const agentA = (await inbox.createToken('agent a', 'agent')).secret;
  const agentB = (await inbox.createToken('agent b', 'agent')).secret;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
    handle(new Request(`http://inbox.test${path}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }));
  return { inbox, call, owner, agentA, agentB };
}

const tagsOf = async (res: Response): Promise<DefaultTags> => (await res.json()) as DefaultTags;

describe('the default tags routes', () => {
  it('writes with PUT /v1/tags and reads them back with GET', async () => {
    const { call, agentA } = await httpSetup();
    const put = await call('PUT', '/v1/tags', { token: agentA, body: { agent: 's1', tags: { repo: 'acme/api' }, from: 'YOUR_ATTENTION_TAGS' } });
    assert.equal(put.status, 200);
    const got = await tagsOf(await call('GET', '/v1/tags?agent=s1', { token: agentA }));
    assert.deepEqual(got.tags, { repo: { value: 'acme/api', from: 'YOUR_ATTENTION_TAGS' } });
  });

  it('never lets a token read or change another token\'s defaults', async () => {
    const { call, agentA, agentB } = await httpSetup();
    await call('PUT', '/v1/tags', { token: agentA, body: { agent: 's1', tags: { repo: 'acme/api' } } });
    // Asked for the same agent id, another token reads its own row, which is empty.
    assert.deepEqual((await tagsOf(await call('GET', '/v1/tags?agent=s1', { token: agentB }))).tags, {});
    // A write by another token touches only its own row, even for the same agent id.
    await call('PUT', '/v1/tags', { token: agentB, body: { agent: 's1', tags: { repo: 'b/repo' } } });
    assert.deepEqual((await tagsOf(await call('GET', '/v1/tags?agent=s1', { token: agentA }))).tags, { repo: { value: 'acme/api', from: 'card_tags' } });
  });

  it('lets the owner read an agent\'s defaults, and nobody else', async () => {
    const { call, owner, agentA } = await httpSetup();
    await call('PUT', '/v1/tags', { token: agentA, body: { agent: 's1', tags: { repo: 'acme/api' } } });
    const list = (await (await call('GET', '/v1/tags?agent=s1', { token: owner })).json()) as { defaults: { token: string; agent: string; tags: DefaultTags['tags'] }[] };
    assert.equal(list.defaults.length, 1);
    assert.deepEqual(list.defaults[0]?.tags, { repo: { value: 'acme/api', from: 'card_tags' } });
    assert.equal((await call('GET', '/v1/tags', { token: owner })).status, 200);
    // An agent must name its agent id, and only an agent writes: the owner reads the list instead.
    assert.equal((await call('GET', '/v1/tags', { token: agentA })).status, 400);
    assert.equal((await call('PUT', '/v1/tags', { token: owner, body: { agent: 's1', tags: { a: 'b' } } })).status, 403);
  });

  it('names the inherited tags in the post\'s reply, and only those', async () => {
    const { call, agentA } = await httpSetup();
    await call('PUT', '/v1/tags', { token: agentA, body: { agent: 's1', tags: { repo: 'acme/api', topic: 'billing' } } });
    const posted = (await (await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', tags: { topic: 'ops', extra: '1' } } })).json()) as { inheritedTags?: string[]; tags?: Record<string, string> };
    assert.deepEqual(posted.inheritedTags, ['repo']);
    assert.deepEqual(posted.tags, { repo: 'acme/api', topic: 'ops', extra: '1' });
  });
});

describe('the card tools and default tags', () => {
  it('card_tags shows every default with what set it, after a change and on a plain read', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const held: DefaultTags = { agent: 's1', tags: { repo: { value: 'acme/api', from: 'card_tags' }, topic: { value: 'billing', from: 'YOUR_ATTENTION_TAGS' } } };
    const inbox = {
      setDefaultTags: async () => held,
      defaultTags: async () => held,
    } as never;
    const ctx = { inbox, secrets: {} as never, agent: 's1', origin: async () => undefined, arrival: 'as a test' };
    const changed = await runTool(ctx, 'card_tags', { tags: { repo: 'acme/api' } });
    assert.match(changed, /repo: acme\/api \(from card_tags\)/);
    assert.match(changed, /topic: billing \(from YOUR_ATTENTION_TAGS\)/);
    const read = await runTool(ctx, 'card_tags', {});
    assert.equal(read, changed);
  });

  it('card_tags says when the session holds none', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const inbox = { defaultTags: async () => ({ agent: 's1', tags: {} }) } as never;
    const text = await runTool({ inbox, secrets: {} as never, agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_tags', {});
    assert.match(text, /no default tags/);
  });

  it('card_post names the tags the card took from the defaults, and says plainly when it took none', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const post = async (inheritedTags?: string[]) => {
      const inbox = { post: async () => ({ id: 'c9', inheritedTags }) } as never;
      return runTool({ inbox, secrets: {} as never, agent: 's1', origin: async () => undefined, arrival: 'as a channel event' }, 'card_post', { title: 'q' });
    };
    assert.match(await post(['repo', 'topic']), /Posted card c9. It took the default tags repo, topic./);
    assert.match(await post([]), /Posted card c9. It took no default tags./);
  });

  it('card_tags does not take an agent field: the tool works on the calling session only', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const ctx = { inbox: {} as never, secrets: {} as never, agent: 's1', origin: async () => undefined, arrival: 'as a test' };
    await assert.rejects(runTool(ctx, 'card_tags', { agent: 'pi:other' }), /card_tags does not take agent/);
  });
});

describe('parseTagsFlag', () => {
  it('reads the pi launcher\'s --tags value', async () => {
    const { parseTagsFlag } = await import('../../src/integrations/tags.ts');
    assert.deepEqual(parseTagsFlag('repo=acme/api,topic=billing'), { repo: 'acme/api', topic: 'billing' });
    assert.equal(parseTagsFlag(''), undefined);
    assert.equal(parseTagsFlag('  '), undefined);
  });

  it('refuses a malformed entry', async () => {
    const { parseTagsFlag } = await import('../../src/integrations/tags.ts');
    assert.throws(() => parseTagsFlag('novalue'), /k=v/);
    assert.throws(() => parseTagsFlag('=v'), /k=v/);
    assert.throws(() => parseTagsFlag(`k=${'v'.repeat(101)}`), /100/);
    assert.throws(() => parseTagsFlag(Array.from({ length: 11 }, (_, i) => `k${i}=v`).join(',')), /10/);
    assert.throws(() => parseTagsFlag('k=a,k=b'), /twice/);
  });
});
