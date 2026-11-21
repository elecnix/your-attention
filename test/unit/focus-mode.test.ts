// Focus mode fills the screen with the open card, from card to card, counts the cards that arrive meanwhile, and raises one notification when it ends.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../../src/core/summary.ts';
import type { Card, CardState } from '../../src/core/types.ts';
import { arrivals, notifiable, readFocusMode, releaseNotice } from '../../web/focus.js';
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

describe('focus mode counts the cards that arrive', () => {
  it('counts the waiting cards the person has not seen since focus began, and leaves out the open card and the closed ones', () => {
    const live = state([card('a'), card('b'), card('c'), card('n'), card('m'), card('x'), card('h')], { x: 'closed', m: 'in-triage', h: 'held' });
    assert.deepEqual(arrivals(['a', 'b', 'c'], live, 'a').map((c) => c.id), ['n', 'h']);
    assert.deepEqual(arrivals(['a', 'b', 'c'], state([card('a'), card('b')]), 'a'), []);
  });

  it('leaves out the open card when it was not listed when focus began, such as a cleared card opened from a link', () => {
    assert.deepEqual(arrivals([], state([card('a')]), 'a'), []);
  });
});

describe('focus mode raises one notification when it ends', () => {
  it('names every card that arrived, or raises none', () => {
    assert.equal(releaseNotice([]), null);
    const one = releaseNotice([summarize(card('n', { title: 'Pick a database' }), undefined)]);
    assert.deepEqual(one, { title: 'A card arrived while you focused', body: 'Pick a database' });
    const two = releaseNotice([summarize(card('n', { title: 'Pick a database' }), undefined), summarize(card('m', { title: 'Approve the deploy' }), undefined)]);
    assert.deepEqual(two, { title: '2 cards arrived while you focused', body: 'Pick a database · Approve the deploy' });
  });

  it('leaves out a card in a muted group, unless it is at the highest level', () => {
    const live = state([card('a', { tags: { topic: 'billing' } }), card('b', { tags: { topic: 'billing' }, priority: 'now' }), card('c', { tags: { topic: 'search' } })]);
    const muted = new Set([buildQueue(live, 'tag:topic').groupOf['a']!]);
    assert.deepEqual(notifiable(live, live.cards, 'tag:topic', [], muted).map((c) => c.id), ['b', 'c']);
  });
});

describe('focus mode as a tab stores it', () => {
  it('reads the cards the person has seen, and where the page and the queue were scrolled', () => {
    assert.deepEqual(readFocusMode({ ids: ['a', 'b'], pageY: 120, queueY: 40 }), { ids: ['a', 'b'], pageY: 120, queueY: 40 });
  });

  it('reads the card an older page stored as one the person has seen, since focus mode no longer belongs to one card', () => {
    assert.deepEqual(readFocusMode({ card: 'z', ids: ['a', 'b'], pageY: 120, queueY: 40 }), { ids: ['a', 'b', 'z'], pageY: 120, queueY: 40 });
    assert.deepEqual(readFocusMode({ card: 'a', ids: ['a', 'b'] }), { ids: ['a', 'b'], pageY: 0, queueY: 0 });
  });

  it('reads a missing or bad scroll position as the top', () => {
    assert.deepEqual(readFocusMode({ ids: ['a'] }), { ids: ['a'], pageY: 0, queueY: 0 });
    assert.deepEqual(readFocusMode({ ids: ['a'], pageY: -3, queueY: 'x' }), { ids: ['a'], pageY: 0, queueY: 0 });
  });

  it('reads anything else as off', () => {
    for (const bad of [null, 'a', { card: '' }, { card: 'a' }, { ids: [1] }, { card: 1, ids: [] }, []]) assert.equal(readFocusMode(bad), null);
  });
});
