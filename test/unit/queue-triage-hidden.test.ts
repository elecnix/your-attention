// A card triage is still checking has no verdict yet, so it is not waiting for the person and the queue leaves it out.
// It appears under its group once a verdict lets it through.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../../src/core/summary.ts';
import type { Card, CardState } from '../../src/core/types.ts';
import { buildQueue, type InboxState } from '../../web/queue.js';

const card = (id: string): Card => ({ id, agent: 'a', kind: 'ask', title: `Card ${id}`, text: 'Pick one.', priority: 'now', deliver: 'stream', version: 1, createdAt: id.charCodeAt(0), updatedAt: 1, replies: [] });

function state(cards: Card[], states: Record<string, CardState>): InboxState {
  return { cards: cards.map((c) => summarize(c, undefined)), answers: {}, presence: {}, states };
}

describe('a card triage is still checking', () => {
  it('stays out of the queue until a verdict arrives', () => {
    const live = state([card('a'), card('b'), card('c')], { a: 'open', b: 'in-triage', c: 'open' });
    const q = buildQueue(live, 'none', []);
    assert.deepEqual(q.order.map((c) => c.id), ['a', 'c']);
    assert.deepEqual(q.pending.map((c) => c.id), ['a', 'c']);
    assert.deepEqual(q.groups.map(([, items]) => items.map((c) => c.id)), [['a', 'c']]);
    // Nothing draws a section for them, so no heading waits on a card the person cannot judge.
    assert.equal('checking' in q, false);
  });

  it('joins its group once triage passes it', () => {
    const after = buildQueue(state([card('a'), card('b')], { a: 'open', b: 'open' }), 'none', []);
    assert.deepEqual(after.order.map((c) => c.id), ['a', 'b']);
  });
});
