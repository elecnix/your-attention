// Focus mode holds the queue still while the person reads one card, and lets everything it held through when focus ends.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../../src/core/summary.ts';
import type { Card, CardState } from '../../src/core/types.ts';
import { arrivals, heldFrom, holdView, notifiable, readFocusMode, releaseNotice } from '../../web/focus.js';
import { buildQueue, type InboxState } from '../../web/queue.js';

const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, agent: 'a', kind: 'ask', title: `Card ${id}`, priority: 'soon', deliver: 'stream', version: 1, createdAt: id.charCodeAt(0), updatedAt: 1, replies: [], ...extra });

function state(cards: Card[], states: Record<string, CardState> = {}): InboxState {
  return {
    cards: cards.map((c) => summarize(c, undefined)),
    answers: {},
    presence: {},
    states: Object.fromEntries(cards.map((c) => [c.id, states[c.id] ?? 'open'])),
    levels: [{ id: 'now', label: 'Decide now', color: '#f00', definition: '' }, { id: 'soon', label: 'Soon', color: '#fa0', definition: '' }],
  };
}
const ids = (s: InboxState) => buildQueue(s, 'none').order.map((c) => c.id);

describe('focus mode holds the queue', () => {
  const held = state([card('a'), card('b'), card('c')]);

  it('keeps the queue as it stood, while cards arrive, rank higher, close or leave', () => {
    const live = state([card('a'), card('n', { priority: 'now' }), card('c', { priority: 'now' }), card('z')], { c: 'closed' });
    const view = holdView(held, live, 'a');
    assert.deepEqual(ids(view), ['a', 'b', 'c']);
  });

  it('shows the open card as it is now: a revision, its state and its answer', () => {
    const live = state([card('a', { title: 'Card a, revised', version: 2 }), card('b')], { a: 'answered' });
    live.answers['a'] = { version: 2, savedAt: 5, deliveredAt: null, readAt: null, forcedAt: null };
    const view = holdView(held, live, 'a');
    const a = view.cards.find((c) => c.id === 'a');
    assert.equal(a?.title, 'Card a, revised');
    assert.equal(a?.version, 2);
    assert.equal(view.states['a'], 'answered');
    assert.deepEqual(view.answers['a'], live.answers['a']);
    assert.equal(view.states['b'], 'open');
  });

  it('keeps the open card in its place in the list after a revision raises its priority', () => {
    const live = state([card('a'), card('b'), card('c', { priority: 'now', title: 'Card c, now urgent' })]);
    live.priorities = { c: 'now' };
    assert.deepEqual(ids(live), ['c', 'a', 'b']);
    const view = holdView(held, live, 'c');
    assert.deepEqual(ids(view), ['a', 'b', 'c']);
    assert.equal(view.cards.find((c) => c.id === 'c')?.title, 'Card c, now urgent');
  });

  it('keeps the held copy of the open card when the inbox no longer lists it', () => {
    const view = holdView(held, state([card('b'), card('c')]), 'a');
    assert.equal(view.cards.find((c) => c.id === 'a')?.title, 'Card a');
    assert.equal(view.states['a'], 'open');
  });

  it('counts the waiting cards that arrived, and leaves out the open card and the closed ones', () => {
    const live = state([card('a'), card('b'), card('c'), card('n'), card('m'), card('x')], { x: 'closed', m: 'in-triage' });
    assert.deepEqual(arrivals(held, live, 'a').map((c) => c.id), ['n']);
    assert.deepEqual(arrivals(held, held, 'a'), []);
  });

  it('rebuilds the held queue after a reload from the ids it held', () => {
    const live = state([card('a'), card('b'), card('n')]);
    const rebuilt = heldFrom(live, ['a', 'b', 'c']);
    assert.deepEqual(rebuilt.cards.map((c) => c.id), ['a', 'b']);
    assert.deepEqual(arrivals(rebuilt, live, 'a').map((c) => c.id), ['n']);
  });
});

describe('focus mode lets the queue through when it ends', () => {
  it('raises one notification for every card that arrived, or none', () => {
    assert.equal(releaseNotice([]), null);
    const one = releaseNotice([summarize(card('n', { title: 'Pick a database' }), undefined)]);
    assert.deepEqual(one, { title: 'A card arrived while you focused', body: 'Pick a database' });
    const two = releaseNotice([summarize(card('n', { title: 'Pick a database' }), undefined), summarize(card('m', { title: 'Approve the deploy' }), undefined)]);
    assert.deepEqual(two, { title: '2 cards arrived while you focused', body: 'Pick a database · Approve the deploy' });
  });

  it('leaves out of the notification a card in a muted group, unless it is at the highest level', () => {
    const live = state([card('a', { tags: { topic: 'billing' } }), card('b', { tags: { topic: 'billing' }, priority: 'now' }), card('c', { tags: { topic: 'search' } })]);
    const muted = new Set([buildQueue(live, 'tag:topic').groupOf['a']!]);
    assert.deepEqual(notifiable(live, live.cards, 'tag:topic', [], muted).map((c) => c.id), ['b', 'c']);
  });

  it('reads a stored focus mode, and anything else as off', () => {
    assert.deepEqual(readFocusMode({ card: 'a', ids: ['a', 'b'] }), { card: 'a', ids: ['a', 'b'] });
    for (const bad of [null, 'a', { card: '' }, { card: 'a' }, { card: 'a', ids: [1] }, []]) assert.equal(readFocusMode(bad), null);
  });
});
