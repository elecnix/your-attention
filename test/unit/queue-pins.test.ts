// Pinned tag values: each one is a group at the top of the queue, under every Group by choice, and each card shows in one group only.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../../src/core/summary.ts';
import type { Card } from '../../src/core/types.ts';
import { buildQueue, type InboxState } from '../../web/queue.js';

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

  it('moves a card with an agent reply into its pinned group', () => {
    const replied = card('r', { topic: 'billing' }, { replies: [{ text: 'more', at: 5, seenAt: null }] });
    const q = buildQueue(state([...cards, replied]), 'none', [['topic', 'billing']]);
    assert.ok(ids(q.pinned[0]?.items ?? []).includes('r'));
    assert.deepEqual(ids(q.replied), []);
  });
});
