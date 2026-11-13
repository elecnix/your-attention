// Pinned tag values: each one is a group at the top of the queue, under every Group by choice, and each card shows in one group only.
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
const ids = (items: { id: string }[]) => items.map((c) => c.id);

describe('pinned tag values', () => {
  it('puts each pinned value in its own group, in pin order, ahead of the rest of the queue', () => {
    const q = buildQueue(state(cards), 'none', [['repo', 'acme/api'], ['topic', 'billing']]);
    assert.deepEqual(q.pinned.map((p) => [p.key, p.value, ids(p.items)]), [['repo', 'acme/api', ['a', 'd']], ['topic', 'billing', ['b']]]);
    assert.deepEqual(q.groups.map(([title, items]) => [title, ids(items)]), [['Waiting for you', ['c', 'e']]]);
    assert.deepEqual(ids(q.order), ['a', 'd', 'b', 'c', 'e']);
  });

  it('gives a card that matches two pins to the oldest pin', () => {
    const q = buildQueue(state(cards), 'none', [['topic', 'billing'], ['repo', 'acme/api']]);
    assert.deepEqual(q.pinned.map((p) => ids(p.items)), [['a', 'b'], ['d']]);
  });

  it('keeps a pinned group with nothing waiting', () => {
    const q = buildQueue(state(cards), 'priority', [['topic', 'nothing here']]);
    assert.deepEqual(q.pinned.map((p) => [p.value, p.items.length]), [['nothing here', 0]]);
  });

  it('keeps the pinned groups under a tag grouping, and names the tag of each other group', () => {
    const q = buildQueue(state(cards), 'tag:topic', [['topic', 'billing']]);
    assert.deepEqual(ids(q.pinned[0]?.items ?? []), ['a', 'b']);
    assert.deepEqual(q.groups.map(([title, items, tag]) => [title, ids(items), tag]), [['search', ['c'], ['topic', 'search']], ['No topic', ['d', 'e'], undefined]]);
  });
});

describe('system cards', () => {
  const withSystem = [...cards, card('s', { repo: 'acme/api' }, { kind: 'system', agent: 'system' })];

  it('sits above the pinned groups, even with the tag a pin matches, in the order and on the page', () => {
    const q = buildQueue(state(withSystem), 'none', [['repo', 'acme/api']]);
    assert.deepEqual(ids(q.systems), ['s']);
    assert.deepEqual(q.pinned.map((p) => ids(p.items)), [['a', 'd']]);
    assert.deepEqual(ids(q.order).slice(0, 1), ['s']);
  });

  it('leaves the queue order when the person collapses its section', () => {
    const q = buildQueue(state(withSystem), 'none', [['repo', 'acme/api']], new Set([SECTION_ID.system]));
    assert.deepEqual(ids(q.systems), ['s'], 'the section keeps its cards, for the count');
    assert.ok(!ids(q.order).includes('s'), 'its cards leave the order, as a collapsed group does');
    assert.deepEqual(ids(q.order).slice(0, 2), ['a', 'd']);
  });

  it('keeps its place when the rest of the queue is grouped or searched', () => {
    const q = buildQueue(state(withSystem), 'tag:repo', [['topic', 'billing']]);
    assert.deepEqual(ids(q.systems), ['s']);
    assert.ok(!q.groups.some(([, items]) => ids(items).includes('s')), 'not inside a group');
    assert.equal(q.order[0]!.id, 's');
  });
});
