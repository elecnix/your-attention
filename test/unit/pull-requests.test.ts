// The pullRequests field: a card stores the GitHub pull requests it is about, as structured data the triage and
// widgets can read, beside the pr tag's text.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InboxError } from '../../src/core/inbox.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import type { NewCard } from '../../src/core/types.ts';
import { agent, httpInbox, setup } from './fixture.ts';

const pr = { owner: 'elecnix', repo: 'your-attention', number: 160 };

describe('pullRequests', () => {
  it('stores one pull request and returns it on read', async () => {
    const { post, call, agentA } = await httpInbox();
    const card = await post(agentA, { title: 'Review the fix', text: 'Ship it?', pullRequests: pr });
    assert.deepEqual(card.pullRequests, pr);
    const res = await call('GET', `/v1/cards/${card.id}`, { token: agentA });
    const detail = (await res.json()) as { card: { pullRequests?: unknown } };
    assert.deepEqual(detail.card.pullRequests, pr);
  });

  it('keeps a single object an object, so a reader sees which shape the card has', async () => {
    const { post, agentA } = await httpInbox();
    const card = await post(agentA, { title: 'One fix', pullRequests: pr });
    assert.equal(Array.isArray(card.pullRequests), false);
  });

  it('stores an array of two, in order', async () => {
    const { post, agentA } = await httpInbox();
    const other = { owner: 'acme', repo: 'api', number: 7 };
    const card = await post(agentA, { title: 'Two fixes', pullRequests: [pr, other] });
    assert.deepEqual(card.pullRequests, [pr, other]);
  });

  it('replaces the field on a patch, and an empty array clears it', async () => {
    const { post, call, agentA } = await httpInbox();
    const card = await post(agentA, { title: 'Review the fix' });
    assert.equal(card.pullRequests, undefined);

    const first = (await (await call('POST', `/v1/cards/${card.id}/patch`, { token: agentA, body: { pullRequests: pr } })).json()) as { pullRequests?: unknown; version: number };
    assert.deepEqual(first.pullRequests, pr);
    assert.equal(first.version, 2);

    const other = { owner: 'acme', repo: 'api', number: 7 };
    const second = (await (await call('POST', `/v1/cards/${card.id}/patch`, { token: agentA, body: { pullRequests: [other] } })).json()) as { pullRequests?: unknown; version: number };
    assert.deepEqual(second.pullRequests, [other]);
    assert.equal(second.version, 3);

    const cleared = (await (await call('POST', `/v1/cards/${card.id}/patch`, { token: agentA, body: { pullRequests: [] } })).json()) as { pullRequests?: unknown; version: number };
    assert.equal(cleared.pullRequests, undefined);
    assert.equal(cleared.version, 4);
  });

  it('keeps the field on a text patch that never names it', async () => {
    const { post, call, agentA } = await httpInbox();
    const card = await post(agentA, { title: 'Review the fix', text: 'Check the diff.', pullRequests: pr });
    const patched = (await (await call('POST', `/v1/cards/${card.id}/patch`, { token: agentA, body: { edits: [{ old: 'Check the diff.', new: 'Check the whole diff.' }] } })).json()) as { text?: string; pullRequests?: unknown };
    assert.equal(patched.text, 'Check the whole diff.');
    assert.deepEqual(patched.pullRequests, pr);
  });

  it('returns the field on a search result, as publicCard gives it', async () => {
    const { post, call, agentA } = await httpInbox();
    const card = await post(agentA, { title: 'Review the fix', text: 'Ship it?', pullRequests: pr });
    const res = await call('GET', `/v1/search?q=Review&format=page`, { token: agentA });
    const page = (await res.json()) as { results: { card: { id: string; pullRequests?: unknown } }[] };
    const hit = page.results.find((r) => r.card.id === card.id);
    assert.deepEqual(hit?.card.pullRequests, pr);
  });

  it('refuses a missing number, a string number, and an unknown key', async () => {
    const { call, agentA } = await httpInbox();
    const missing = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: { owner: 'elecnix', repo: 'your-attention' } } });
    assert.equal(missing.status, 400);
    assert.match((await missing.json() as { error: string }).error, /number/);

    const str = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: { ...pr, number: '160' } } });
    assert.equal(str.status, 400);
    assert.match((await str.json() as { error: string }).error, /number/);

    const extra = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: { ...pr, title: 'Merge it' } } });
    assert.equal(extra.status, 400);
    assert.match((await extra.json() as { error: string }).error, /title/);
  });

  it('refuses an empty array, an empty object, and more than 20 entries', async () => {
    const { call, agentA } = await httpInbox();
    const empty = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: [] } });
    assert.equal(empty.status, 400);
    assert.match((await empty.json() as { error: string }).error, /empty|1 to 20|at least/);

    const bare = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: {} } });
    assert.equal(bare.status, 400);

    const many = Array.from({ length: 21 }, (_, i) => ({ owner: 'elecnix', repo: 'your-attention', number: i + 1 }));
    const over = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: many } });
    assert.equal(over.status, 400);
    assert.match((await over.json() as { error: string }).error, /20/);
  });

  it('refuses a repo name with a slash and a non-positive number', async () => {
    const { call, agentA } = await httpInbox();
    const slash = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: { owner: 'elecnix', repo: 'elecnix/your-attention', number: 160 } } });
    assert.equal(slash.status, 400);
    assert.match((await slash.json() as { error: string }).error, /repo/);

    const zero = await call('POST', '/v1/cards', { token: agentA, body: { agent: 's1', title: 'q', pullRequests: { owner: 'elecnix', repo: 'your-attention', number: 0 } } });
    assert.equal(zero.status, 400);
    assert.match((await zero.json() as { error: string }).error, /number/);
  });

  it('posts without the field, and the pr tag alone still works as before', async () => {
    const { post, agentA } = await httpInbox();
    const card = await post(agentA, { title: 'Review the fix', tags: { pr: 'elecnix/your-attention#160' } });
    assert.equal(card.pullRequests, undefined);
    assert.equal(card.tags?.['pr'], 'elecnix/your-attention#160');
  });

  it('a null pullRequests on a patch clears the field', async () => {
    const { post, call, agentA } = await httpInbox();
    const card = await post(agentA, { title: 'Review the fix', text: 'Ship it?', pullRequests: pr });
    assert.deepEqual(card.pullRequests, pr);
    const cleared = (await (await call('POST', `/v1/cards/${card.id}/patch`, { token: agentA, body: { pullRequests: null } })).json()) as { pullRequests?: unknown };
    assert.equal(cleared.pullRequests, undefined);
  });
});

// The tool path: card_post carries the field to the inbox, and card_read and card_search show it back.
const toolCtx = (inbox: unknown) => ({ inbox: inbox as never, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' });

describe('pullRequests through the card tools', () => {
  it('card_post carries the field to the inbox unchanged', async () => {
    let posted: NewCard | undefined;
    const inbox = { post: async (c: NewCard) => { posted = c; return { id: 'c1', inheritedTags: [] }; } };
    await runTool(toolCtx(inbox), 'card_post', { title: 'Review the fix', text: 'Ship it?', pullRequests: pr });
    assert.deepEqual(posted?.pullRequests, pr);
    await runTool(toolCtx(inbox), 'card_post', { title: 'Review both', text: 'Ship it?', pullRequests: [pr, { owner: 'acme', repo: 'api', number: 7 }] });
    assert.deepEqual(posted?.pullRequests, [pr, { owner: 'acme', repo: 'api', number: 7 }]);
  });

  it('card_post refuses each bad shape, because the inbox is the gate', async () => {
    const { inbox } = setup();
    const post = (pullRequests: unknown) => runTool(toolCtx({ post: async (c: NewCard) => inbox.postCard(agent, c) }), 'card_post', { title: 'q', text: 'Ship it?', pullRequests });
    const cases: [string, unknown, RegExp][] = [
      ['a missing number', { owner: 'elecnix', repo: 'your-attention' }, /number/],
      ['a string number', { ...pr, number: '160' }, /number/],
      ['an unknown key', { ...pr, title: 'Merge it' }, /title/],
      ['an empty array', [], /empty/],
      ['more than 20', Array.from({ length: 21 }, (_, i) => ({ owner: 'elecnix', repo: 'your-attention', number: i + 1 })), /20/],
      ['a repo with a slash', { owner: 'elecnix', repo: 'elecnix/your-attention', number: 160 }, /repo/],
    ];
    for (const [label, value, message] of cases) await assert.rejects(post(value), (e: unknown) => e instanceof InboxError && e.status === 400 && message.test(e.message), label);
  });

  it('card_read prints the pull requests the card carries', async () => {
    const { inbox } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Review', pullRequests: [pr, { owner: 'acme', repo: 'api', number: 7 }] });
    const read = await runTool(toolCtx({ get: async (id: string) => ({ card: inbox.getCard(id), state: 'open' }) }), 'card_read', { card_id: 'c1' });
    assert.match(read, /Pull requests: elecnix\/your-attention#160, acme\/api#7/);
  });

  it('card_search returns the field on a result', async () => {
    const { inbox } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Review the fix', pullRequests: pr });
    const card = inbox.getCard('c1');
    const page = { results: [{ card, state: 'open' as const }] };
    const out = await runTool(toolCtx({ search: async () => page }), 'card_search', { query: 'Review' });
    const parsed = JSON.parse(out) as { results: { pullRequests?: unknown }[] };
    assert.deepEqual(parsed.results[0]?.pullRequests, pr);
  });
});
