// An agent's follow-up is a new card that follows the earlier one. The reply route is gone and answers 410.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { Card } from '../../src/core/types.ts';

async function setup() {
  const store = new MemoryStorage();
  const inbox = new Inbox(store);
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const owner = (await inbox.createToken('page', 'owner')).secret;
  const agent = (await inbox.createToken('agents', 'agent')).secret;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await handle(new Request(`http://inbox.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { inbox, store, call, owner, agent };
}

describe('linked follow-ups', () => {
  it('answers the reply route with 410 and a message that names follows', async () => {
    const { call, agent, owner } = await setup();
    await call('POST', '/v1/cards', agent, { id: 'c1', agent: 's1', title: 'q' });
    for (const token of [agent, owner]) {
      const res = await call('POST', '/v1/cards/c1/reply', token, { text: 'more' });
      assert.equal(res.status, 410);
      assert.match(String(res.body['error']), /follows/);
      assert.match(String(res.body['error']), /c1/);
    }
    assert.deepEqual(((await call('GET', '/v1/cards/c1', agent)).body['card'] as Card).replies, [], 'the refused call stored nothing');
  });

  it('answers 410 for a card that does not exist, because the route is gone for every id', async () => {
    const { call, agent } = await setup();
    assert.equal((await call('POST', '/v1/cards/missing/reply', agent, { text: 'x' })).status, 410);
  });

  it('links a card posted with follows to the earlier card, and the earlier card back to it', async () => {
    const { call, agent } = await setup();
    await call('POST', '/v1/cards', agent, { id: 'c1', agent: 's1', title: 'first' });
    const posted = await call('POST', '/v1/cards', agent, { id: 'c2', agent: 's1', title: 'second', follows: 'c1' });
    assert.equal(posted.status, 201);
    const first = (await call('GET', '/v1/cards/c1', agent)).body['card'] as Card;
    const second = (await call('GET', '/v1/cards/c2', agent)).body['card'] as Card;
    assert.equal(second.follows, 'c1');
    assert.equal(first.followedBy, 'c2');
  });

  it('keeps the replies a card already stores readable', async () => {
    const { call, agent, store } = await setup();
    await call('POST', '/v1/cards', agent, { id: 'c1', agent: 's1', title: 'q' });
    const card = store.get<Card>('cards', 'c1')!;
    store.put('cards', 'c1', { ...card, replies: [{ text: 'old reply', at: 5, seenAt: null }] });
    const read = (await call('GET', '/v1/cards/c1', agent)).body['card'] as Card;
    assert.deepEqual(read.replies.map((r) => r.text), ['old reply']);
  });
});
