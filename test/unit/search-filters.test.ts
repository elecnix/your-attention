// card_search filters: list cards by state, tags, agent, time and links, with a cursor over long results.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InboxError, ORPHAN_MS } from '../../src/core/inbox.ts';
import { NOW, setup } from './fixture.ts';

/** An inbox with four cards in every common state: two open, one answered, one closed. */
function seeded() {
  const world = setup();
  const { inbox, agent } = world;
  inbox.postCard(agent, {
    id: 'open-one', agent: 'merge-agent', title: 'Merge the fix?', tags: { priority: 'P1', repo: 'acme/api' },
    origin: { name: 'the merge session' },
    text: 'Context in [[setup-guide]] and the change at https://github.com/acme/api/pull/9',
  });
  world.clock.advance(60_000);
  inbox.postCard(agent, { id: 'open-two', agent: 'deploy-agent', title: 'Deploy the build?', tags: { repo: 'acme/api' } });
  world.clock.advance(60_000);
  inbox.postCard(agent, { id: 'answered-one', agent: 'merge-agent', title: 'Which cache?', tags: { topic: 'cache' } });
  return { ...world, answer: () => inbox.answer('answered-one', { values: {}, comment: 'Use the local cache.' }) };
}

describe('search filters', () => {
  it('lists every open card with no query, each carrying its state, tags, agent and times', async () => {
    const { inbox, answer } = seeded();
    await answer();
    const page = inbox.search('', { state: 'open' });
    assert.deepEqual(page.results.map((r) => r.card.id).sort(), ['open-one', 'open-two']);
    const one = page.results.find((r) => r.card.id === 'open-one');
    assert.equal(one?.state, 'open');
    assert.deepEqual(one?.card.tags, { priority: 'P1', repo: 'acme/api' });
    assert.equal(one?.card.agent, 'merge-agent');
    assert.equal(typeof one?.card.createdAt, 'number');
    assert.equal(typeof one?.card.updatedAt, 'number');
    assert.equal(page.nextCursor, undefined);
  });

  it('treats a lone asterisk as no query', async () => {
    const { inbox, answer } = seeded();
    await answer();
    assert.deepEqual(inbox.search('*', { state: 'closed' }).results.length, 0);
    assert.deepEqual(inbox.search('*', { state: 'answered' }).results.map((r) => r.card.id), ['answered-one']);
  });

  it('keeps order by the last change, newest first, when nothing matches the words alone', async () => {
    const { inbox, answer } = seeded();
    await answer();
    assert.deepEqual(inbox.search('', {}).results.map((r) => r.card.id), ['answered-one', 'open-two', 'open-one']);
  });

  it('filters by a tag key alone, or a key and value, and every tag must match', async () => {
    const { inbox, answer } = seeded();
    await answer();
    assert.deepEqual(inbox.search('', { tags: ['priority'] }).results.map((r) => r.card.id), ['open-one']);
    assert.deepEqual(inbox.search('', { tags: ['repo=acme/api'] }).results.map((r) => r.card.id).sort(), ['open-one', 'open-two']);
    assert.deepEqual(inbox.search('', { tags: ['repo=acme/api', 'priority=P1'] }).results.map((r) => r.card.id), ['open-one']);
    assert.deepEqual(inbox.search('', { tags: ['priority=P2'] }).results, []);
  });

  it('filters by the posting agent, as an id or a piece of its session name', async () => {
    const { inbox, answer } = seeded();
    await answer();
    assert.deepEqual(inbox.search('', { agent: 'merge-agent' }).results.map((r) => r.card.id).sort(), ['answered-one', 'open-one']);
    assert.deepEqual(inbox.search('', { agent: 'merge session' }).results.map((r) => r.card.id), ['open-one']);
    assert.deepEqual(inbox.search('', { agent: 'MERGE SESSION' }).results.map((r) => r.card.id), ['open-one']);
    assert.deepEqual(inbox.search('', { agent: 'nobody' }).results, []);
  });

  it('filters by the posted or updated time', async () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'early', agent: 's1', title: 'Early card', text: 'first' });
    clock.advance(10 * 60_000);
    inbox.patchCard(agent, 'early', [{ old: 'first', new: 'edited' }]);
    clock.advance(60_000);
    inbox.postCard(agent, { id: 'late', agent: 's1', title: 'Late card' });
    // `since` reads the updated time too: the edit lifts the early card into the window.
    assert.deepEqual(inbox.search('', { since: NOW + 5 * 60_000 }).results.map((r) => r.card.id).sort(), ['early', 'late']);
    assert.deepEqual(inbox.search('', { before: NOW + 1 }).results.map((r) => r.card.id), ['early']);
    assert.deepEqual(inbox.search('', { since: NOW + 5 * 60_000, before: NOW + 10 * 60_000 }).results.map((r) => r.card.id), ['early']);
  });

  it('filters by a card id or a URL the card links', async () => {
    const { inbox, answer } = seeded();
    await answer();
    assert.deepEqual(inbox.search('', { links: 'setup-guide' }).results.map((r) => r.card.id), ['open-one']);
    assert.deepEqual(inbox.search('', { links: 'acme/api/pull/9' }).results.map((r) => r.card.id), ['open-one']);
    // A tag value that reads like the URL is not a link.
    assert.deepEqual(inbox.search('', { links: 'acme/api' }).results.map((r) => r.card.id).sort(), ['open-one']);
    assert.deepEqual(inbox.search('', { links: 'other-repo' }).results, []);
  });

  it('combines the words with the filters', async () => {
    const { inbox, answer } = seeded();
    await answer();
    assert.deepEqual(inbox.search('cache', {}).results.map((r) => r.card.id), ['answered-one']);
    assert.deepEqual(inbox.search('cache', { state: 'open' }).results, []);
    assert.deepEqual(inbox.search('cache', { state: 'answered' }).results.map((r) => r.card.id), ['answered-one']);
    const withAnswer = inbox.search('cache', { state: 'answered' }).results[0];
    assert.equal(withAnswer?.answer?.comment, 'Use the local cache.');
    assert.equal(withAnswer?.state, 'answered');
  });

  it('keeps the answered option, with or without other filters', async () => {
    const { inbox, answer } = seeded();
    await answer();
    assert.deepEqual(inbox.search('', { answered: true }).results.map((r) => r.card.id), ['answered-one']);
    assert.deepEqual(inbox.search('', { answered: true, tags: ['repo'] }).results, []);
  });

  it('reads an open card whose agent left long ago as orphaned', async () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'ghost', agent: 'gone-agent', title: 'Still yours?' });
    clock.advance(ORPHAN_MS + 1);
    inbox.postCard(agent, { id: 'fresh', agent: 's1', title: 'New card' });
    assert.deepEqual(inbox.search('', { state: 'orphaned' }).results.map((r) => r.card.id), ['ghost']);
    assert.deepEqual(inbox.search('', { state: 'open' }).results.map((r) => r.card.id), ['fresh']);
  });

  it('pages a long list with a cursor, so nothing is silently cut short', async () => {
    const { inbox, agent, clock } = setup();
    for (let i = 1; i <= 5; i++) {
      inbox.postCard(agent, { id: `p${i}`, agent: 's1', title: `Card ${i}` });
      clock.advance(1000);
    }
    const first = inbox.search('', { state: 'open', limit: 2 });
    assert.deepEqual(first.results.map((r) => r.card.id), ['p5', 'p4']);
    assert.ok(first.nextCursor);
    const second = inbox.search('', { state: 'open', limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.results.map((r) => r.card.id), ['p3', 'p2']);
    const last = inbox.search('', { state: 'open', limit: 2, cursor: second.nextCursor });
    assert.deepEqual(last.results.map((r) => r.card.id), ['p1']);
    assert.equal(last.nextCursor, undefined);
    const seen = [first, second, last].flatMap((p) => p.results.map((r) => r.card.id));
    assert.equal(new Set(seen).size, 5, 'no card repeats across the pages');
  });

  it('pages a word search with a cursor', async () => {
    const { inbox, agent, clock } = setup();
    for (let i = 1; i <= 4; i++) {
      inbox.postCard(agent, { id: `w${i}`, agent: 's1', title: `Deploy build ${i}` });
      clock.advance(1000);
    }
    const first = inbox.search('deploy', { limit: 2 });
    assert.equal(first.results.length, 2);
    const second = inbox.search('deploy', { limit: 2, cursor: first.nextCursor });
    assert.equal(second.results.length, 2);
    assert.equal(second.nextCursor, undefined);
  });

  it('refuses a cursor it cannot read', () => {
    const { inbox } = setup();
    assert.throws(() => inbox.search('', { cursor: 'junk!' }), (e: unknown) => e instanceof InboxError && e.status === 400);
    assert.throws(() => inbox.search('', { cursor: btoa('later') }), (e: unknown) => e instanceof InboxError && e.status === 400);
  });

  it('refuses a state it does not have', () => {
    const { inbox } = setup();
    assert.throws(() => inbox.search('', { state: 'paused' as never }), (e: unknown) => e instanceof InboxError && e.status === 400);
  });
});

describe('the cards listing route takes the same filters', () => {
  it('lists the caller\'s cards by state and tag, scoped to its token', async () => {
    const { inbox, agent } = seeded();
    const other = { token: 'tb', role: 'agent' } as const;
    const page = inbox.listCards(agent, { state: 'open', tags: ['repo'] });
    assert.deepEqual(page.results.map((r) => r.card.id).sort(), ['open-one', 'open-two']);
    assert.equal(page.results[0]?.state, 'open');
    assert.equal(inbox.listCards(other).results.length, 0);
  });

  it('pages with a cursor when a limit is given, and returns everything otherwise', async () => {
    const { inbox, agent } = setup();
    for (let i = 1; i <= 3; i++) inbox.postCard(agent, { id: `l${i}`, agent: 's1', title: `q${i}` });
    assert.equal(inbox.listCards(agent).results.length, 3);
    const first = inbox.listCards(agent, { limit: 2 });
    assert.equal(first.results.length, 2);
    assert.ok(first.nextCursor);
    const rest = inbox.listCards(agent, { limit: 2, cursor: first.nextCursor });
    assert.equal(rest.results.length, 1);
    assert.equal(rest.nextCursor, undefined);
  });
});
