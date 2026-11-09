// Collapsed groups: a group the person muted keeps its heading and its count, and its cards leave the
// queue order, but Skip for now, the card after an answer and a new card all pass over them. A group is
// named by its kind and its value, so switching Group by and back restores the collapsed groups.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../../src/core/summary.ts';
import type { Card } from '../../src/core/types.ts';
import { buildQueue, SECTION_ID, type InboxState } from '../../web/queue.js';

const card = (id: string, tags: Record<string, string>, extra: Partial<Card> = {}): Card => ({ id, agent: 'a', kind: 'ask', title: `Card ${id}`, priority: 'now', deliver: 'stream', version: 1, createdAt: id.charCodeAt(0), updatedAt: 1, replies: [], tags, ...extra });

function state(cards: Card[]): InboxState {
  return { cards: cards.map((c) => summarize(c, undefined)), answers: {}, presence: {}, states: Object.fromEntries(cards.map((c) => [c.id, 'open'])) };
}

const cards = [
  card('a', { topic: 'billing', repo: 'acme/api' }),
  card('b', { topic: 'billing' }),
  card('c', { topic: 'search' }),
  card('d', { repo: 'acme/api' }),
  card('e', {}),
];
const pins: [string, string][] = [['topic', 'billing']];
const ids = (items: { id: string }[]) => items.map((c) => c.id);

describe('collapsed groups', () => {
  it('names each group by its kind and value, so a Group by round trip restores it', () => {
    const q = buildQueue(state(cards), 'tag:topic', pins);
    assert.equal(q.pinned[0]?.id, 'pin: topic: billing');
    assert.deepEqual(q.groups.map(([, , , id]) => id), ['tag: topic: search', 'tag: topic']);
    assert.deepEqual(buildQueue(state(cards), 'none').groups.map(([, , , id]) => id), ['none: Waiting for you']);
    const byAgent = buildQueue(state(cards), 'agent');
    assert.deepEqual(byAgent.groups.map(([, , , id]) => id), ['agent: a']);
    const byPriority = buildQueue(state(cards), 'priority');
    assert.deepEqual(byPriority.groups.map(([, , , id]) => id), ['priority: now']);
  });

  it('hides a collapsed group\'s cards from the queue and the skip order, and keeps its cards for the count', () => {
    const q = buildQueue(state(cards), 'tag:topic', [], new Set(['tag: topic: search']));
    assert.deepEqual(ids(q.order), ['a', 'b', 'd', 'e']);
    assert.deepEqual([...q.hidden], ['c']);
    assert.deepEqual(ids(q.groups.find(([, , , id]) => id === 'tag: topic: search')?.[1] ?? []), ['c']);
    assert.equal(q.groupOf['c'], 'tag: topic: search');
  });

  it('collapses a pinned group the same way', () => {
    const q = buildQueue(state(cards), 'none', pins, new Set(['pin: topic: billing']));
    assert.deepEqual(ids(q.order), ['c', 'd', 'e']);
    assert.deepEqual([...q.hidden].sort(), ['a', 'b']);
    assert.deepEqual(ids(q.pinned[0]?.items ?? []), ['a', 'b']);
    assert.equal(q.groupOf['a'], 'pin: topic: billing');
  });

  it('names the section of every card, so the terminal key can collapse the group on screen', () => {
    const done = card('s', {}, { closed: { kind: 'retracted', at: 9, outcome: 'No longer needed.' } });
    const s = state([...cards, done]);
    s.states['s'] = 'closed';
    const q = buildQueue(s, 'none');
    assert.equal(q.groupOf['s'], SECTION_ID.sent);
    assert.equal(q.groupOf['a'], 'none: Waiting for you');
  });

  it('keeps a tag group apart from a section, a pinned group or a value that reads (none)', () => {
    const tagged = [card('t1', { section: 'outbox' }), card('t2', { topic: '(none)' }), card('t3', {})];
    const bySection = buildQueue(state(tagged), 'tag:section');
    const outboxGroup = bySection.groups.find(([, , , id]) => id === 'tag: section: outbox');
    assert.deepEqual(ids(outboxGroup?.[1] ?? []), ['t1']);
    assert.notEqual(outboxGroup?.[3], SECTION_ID.outbox);
    assert.ok(bySection.groups.some(([, , , id]) => id === 'tag: section'));
    // A value of (none) and no value at all are two groups with two ids.
    const byTopic = buildQueue(state(tagged), 'tag:topic');
    assert.deepEqual(ids(byTopic.groups.find(([, , , id]) => id === 'tag: topic: (none)')?.[1] ?? []), ['t2']);
    assert.deepEqual(ids(byTopic.groups.find(([, , , id]) => id === 'tag: topic')?.[1] ?? []), ['t1', 't3']);
  });

  it('escapes a colon in a tag key or value, so no tag can forge another group\'s id', () => {
    const forged = [card('f1', { a: 'b: c' }), card('f2', { 'a: b': 'c' })];
    const byA = buildQueue(state(forged), 'tag:a');
    const byAB = buildQueue(state(forged), 'tag:a: b');
    const idOf = (q: typeof byA) => q.groups.map(([, , , id]) => id).sort();
    assert.deepEqual(idOf(byA), ['tag: a', 'tag: a: b%3A c']);
    assert.deepEqual(idOf(byAB), ['tag: a%3A b', 'tag: a%3A b: c']);
    assert.deepEqual(idOf(byA).filter((id) => id !== 'tag: a'), ['tag: a: b%3A c']);
  });

  it('leaves the queue as it was with no collapsed group', () => {
    const q = buildQueue(state(cards), 'none', pins);
    assert.deepEqual(ids(q.order), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(q.hidden.size, 0);
  });
});
