// GET /v1/state sends one summary per card the page shows, and the client fetches the whole card from GET /v1/cards/<id>.
// The state reads only the summaries, so its time follows the cards on show, never the size of their text.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { CardSummary } from '../../src/core/summary.ts';

const LIMIT = 50;
import type { Answer, Card } from '../../src/core/types.ts';

async function setup(store = new MemoryStorage(), shownCardLimit?: number) {
  const inbox = new Inbox(store, Date.now, undefined, { shownCardLimit });
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const owner = (await inbox.createToken('page', 'owner', { pinExempt: true })).secret;
  const agent = (await inbox.createToken('agents', 'agent')).secret;
  const call = async <T>(method: string, path: string, token: string, body?: unknown) => {
    const res = await handle(new Request(`http://inbox.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as T };
  };
  type State = { cards: CardSummary[]; answers: Record<string, Partial<Answer>>; states: Record<string, string> };
  const state = async () => (await call<State>('GET', '/v1/state', owner)).body;
  return { inbox, store, call, owner, agent, state };
}

describe('the state sends card summaries', () => {
  it('sends what the queue needs and none of the card\'s content', async () => {
    const { call, agent, owner, state } = await setup();
    await call('POST', '/v1/cards', agent, { id: 'c1', agent: 's', title: 'Merge?', text: `See [[c0]] first. ${'x'.repeat(2000)}`, body: 'root = Card([a])\na = TextContent("secret plan")', html: '<p>big</p>', tags: { topic: 'release' }, origin: { name: 'release agent', harness: 'pi', cwd: '/home/me/repo' } });
    await call('POST', '/v1/cards/c1/reply', agent, { text: 'One more thing.' });
    await call('POST', '/v1/cards/c1/answer', owner, { values: { choice: 'yes' }, comment: 'go ahead' });
    const s = await state();
    const c = s.cards[0]!;
    assert.equal(c.title, 'Merge?');
    assert.deepEqual(c.links, ['c0']);
    assert.equal(c.preview?.length, 300);
    assert.deepEqual(c.tags, { topic: 'release' });
    assert.deepEqual(c.origin, { name: 'release agent', harness: 'pi' });
    assert.equal(c.unseenReplies, true);
    assert.ok(c.replyAt);
    const sent = JSON.stringify(s);
    for (const content of ['secret plan', '<p>big</p>', 'One more thing.', 'go ahead', '/home/me/repo', '"yes"']) assert.equal(sent.includes(content), false, content);
    assert.equal(s.states['c1'], 'answered');
    assert.ok(s.answers['c1']?.savedAt);
  });

  it('serves the whole card, its answer and the rev of its summary at GET /v1/cards/<id>', async () => {
    const { call, agent, owner, state } = await setup();
    await call('POST', '/v1/cards', agent, { id: 'c1', agent: 's', title: 'Q', text: 'Long text.' });
    const before = (await state()).cards[0]!.rev;
    await call('POST', '/v1/cards/c1/answer', owner, { comment: 'done' });
    const after = (await state()).cards[0]!.rev;
    assert.notEqual(after, before, 'an answer changes the rev');
    const d = (await call<{ card: Card; answer: Answer; state: string; rev: string }>('GET', '/v1/cards/c1', owner)).body;
    assert.equal(d.card.text, 'Long text.');
    assert.equal(d.answer.comment, 'done');
    assert.equal(d.state, 'answered');
    assert.equal(d.rev, after);
    await call('POST', '/v1/cards/c1/seen', owner, {});
    await call('POST', '/v1/cards/c1/close', agent, { kind: 'resolved', outcome: 'ok' });
    assert.notEqual((await state()).cards[0]!.rev, after, 'a close changes the rev');
  });

  it('leaves cleared cards out, and a revision brings one back', async () => {
    const { call, agent, owner, state } = await setup();
    await call('POST', '/v1/cards', agent, { id: 'c1', agent: 's', title: 'Q' });
    await call('POST', '/v1/cards/c1/answer', owner, {});
    await call('POST', '/v1/archive', owner, {});
    assert.deepEqual((await state()).cards, []);
    await call('POST', '/v1/cards', agent, { id: 'c1', agent: 's', title: 'Q again' });
    assert.equal((await state()).cards[0]?.title, 'Q again');
  });

  it('writes the summaries of an inbox stored before them', async () => {
    const store = new MemoryStorage();
    store.put('cards', 'old', { id: 'old', agent: 's', kind: 'ask', title: 'Old card', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] } satisfies Card);
    const { state } = await setup(store);
    assert.equal((await state()).cards[0]?.title, 'Old card');
  });

  it('counts the inbox\'s own cards, so pairing requests cannot pile up past the limit', async () => {
    const { inbox, state } = await setup(new MemoryStorage(), 3);
    const refused: number[] = [];
    for (let i = 0; i < 5; i++) {
      try { await inbox.requestPairing(`device ${i}`, 'agent'); } catch (e) { refused.push((e as { status: number }).status); }
    }
    assert.ok((await state()).cards.length <= 3);
    assert.ok(refused.includes(507));
  });

  it('shows every card on an inbox without a limit, as the laptop has', async () => {
    const { inbox, call, agent, state } = await setup();
    for (let i = 0; i < 600; i++) inbox.postCard({ token: 'a', role: 'agent' }, { id: `c${i}`, agent: 's', title: `Card ${i}` });
    assert.equal((await call('POST', '/v1/cards', agent, { id: 'one-more', agent: 's', title: 'One more' })).status, 201);
    assert.equal((await state()).cards.length, 601);
  });

  it('with a limit, as the hosted inbox has, a new card past it waits until the person clears some', async () => {
    const { inbox, call, agent, owner } = await setup(new MemoryStorage(), LIMIT);
    for (let i = 0; i < LIMIT; i++) inbox.postCard({ token: 'a', role: 'agent' }, { id: `c${i}`, agent: 's', title: `Card ${i}` });
    const full = await call<{ error: string }>('POST', '/v1/cards', agent, { id: 'one-more', agent: 's', title: 'One more' });
    assert.equal(full.status, 507);
    assert.match(full.body.error, /clear answered or closed cards/);
    // A revision of a card on show still goes in.
    assert.equal((await call('POST', '/v1/cards', owner, { id: 'c1', agent: 's', title: 'Card 1, revised' })).status, 201);
    await inbox.answer('c2', {});
    await call('POST', '/v1/archive', owner, {});
    assert.equal((await call('POST', '/v1/cards', agent, { id: 'one-more', agent: 's', title: 'One more' })).status, 201);
  });
});
