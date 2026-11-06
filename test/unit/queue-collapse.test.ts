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
    assert.deepEqual(q.groups.map(([, , , id]) => id), ['topic: search', 'topic: (none)']);
    assert.deepEqual(buildQueue(state(cards), 'none').groups.map(([, , , id]) => id), ['none: Waiting for you']);
    const byAgent = buildQueue(state(cards), 'agent');
    assert.deepEqual(byAgent.groups.map(([, , , id]) => id), ['agent: a']);
    const byPriority = buildQueue(state(cards), 'priority');
    assert.deepEqual(byPriority.groups.map(([, , , id]) => id), ['priority: now']);
  });

  it('hides a collapsed group\'s cards from the queue and the skip order, and keeps its cards for the count', () => {
    const q = buildQueue(state(cards), 'tag:topic', [], new Set(['topic: search']));
    assert.deepEqual(ids(q.order), ['a', 'b', 'd', 'e']);
    assert.deepEqual([...q.hidden], ['c']);
    assert.deepEqual(ids(q.groups.find(([, , , id]) => id === 'topic: search')?.[1] ?? []), ['c']);
    assert.equal(q.groupOf['c'], 'topic: search');
  });

  it('collapses a pinned group the same way', () => {
    const q = buildQueue(state(cards), 'none', pins, new Set(['pin: topic: billing']));
    assert.deepEqual(ids(q.order), ['c', 'd', 'e']);
    assert.deepEqual([...q.hidden].sort(), ['a', 'b']);
    assert.deepEqual(ids(q.pinned[0]?.items ?? []), ['a', 'b']);
    assert.equal(q.groupOf['a'], 'pin: topic: billing');
  });

  it('passes over Agent replied when that section is collapsed', () => {
    const replied = card('r', {}, { replies: [{ text: 'more', at: 5, seenAt: null }] });
    const q = buildQueue(state([...cards, replied]), 'none', [], new Set([SECTION_ID.replied]));
    assert.deepEqual(ids(q.order), ids(cards));
    assert.deepEqual([...q.hidden], ['r']);
    assert.equal(q.groupOf['r'], SECTION_ID.replied);
  });

  it('names the section of every card, so the terminal key can collapse the group on screen', () => {
    const done = card('s', {}, { closed: { kind: 'retracted', at: 9, outcome: 'No longer needed.' } });
    const s = state([...cards, done]);
    s.states['s'] = 'closed';
    const q = buildQueue(s, 'none');
    assert.equal(q.groupOf['s'], SECTION_ID.sent);
    assert.equal(q.groupOf['a'], 'none: Waiting for you');
  });

  it('leaves the queue as it was with no collapsed group', () => {
    const q = buildQueue(state(cards), 'none', pins);
    assert.deepEqual(ids(q.order), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(q.hidden.size, 0);
  });
});
