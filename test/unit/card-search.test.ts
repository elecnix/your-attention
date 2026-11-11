// The page's search: case-insensitive substrings over the card summary and over the whole card copy the page has cached.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../../src/core/summary.ts';
import type { Answer, Card } from '../../src/core/types.ts';
import { highlightParts, matchCard, searchTerms } from '../../web/search.js';

const card = (extra: Partial<Card> = {}): Card => ({ id: 'a', agent: 'agent-one', kind: 'ask', title: 'Ship the invoice fix?', priority: 'now', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [], ...extra });
const find = (query: string, c: Card, answer?: Partial<Answer>) => matchCard(searchTerms(query), summarize(c, undefined), { card: c, answer: answer as Answer });

describe('search terms', () => {
  it('lowercases and splits on spaces, and a blank query has none', () => {
    assert.deepEqual(searchTerms('  Invoice   FIX '), ['invoice', 'fix']);
    assert.deepEqual(searchTerms('   '), []);
  });
});

describe('matching a card', () => {
  it('matches the title in any case, without a snippet', () => {
    assert.deepEqual(find('INVOICE', card()), {});
  });
  it('needs every term, in any field', () => {
    const c = card({ tags: { topic: 'billing' } });
    assert.ok(find('invoice billing', c));
    assert.equal(find('invoice refund', c), null);
  });
  it('matches a tag, the session name, the status and a closed outcome', () => {
    assert.ok(find('billing', card({ tags: { topic: 'billing' } })));
    assert.ok(find('release agent', card({ origin: { name: 'the release agent' } })));
    assert.ok(find('waiting on ci', card({ status: 'waiting on CI' })));
    assert.ok(find('went stale', card({ closed: { kind: 'expired', outcome: 'The card went stale', at: 2 } })));
  });
  it('matches the text of the whole card that the summary cut off', () => {
    const c = card({ text: `${'x'.repeat(400)} the needle sits here` });
    assert.equal(matchCard(['needle'], summarize(c, undefined)), null);
    const hit = find('needle', c);
    assert.equal(hit?.snippet?.hit, 'needle');
    assert.equal(hit?.snippet?.label, 'Text');
  });
  it('matches options, questions, the recommendation and a reply', () => {
    assert.ok(find('rollback', card({ options: [{ id: 'o', label: 'Rollback now' }] })));
    assert.ok(find('which region', card({ questions: [{ question: 'Which region?' }] })));
    assert.ok(find('prefer blue', card({ recommendation: 'I prefer blue' })));
    assert.ok(find('old note', card({ replies: [{ text: 'An old note', at: 1, seenAt: null }] })));
  });
  it('matches the answer comment and the answer values', () => {
    assert.ok(find('ship it friday', card(), { comment: 'Ship it Friday', values: {} }));
    assert.ok(find('blue', card(), { comment: '', values: { color: 'Blue', many: ['Red', 'Green'] } }));
    assert.ok(find('green', card(), { comment: '', values: { many: ['Red', 'Green'] } }));
  });
  it('treats a character that means something in a pattern as itself', () => {
    assert.ok(find('a.b(', card({ text: 'see a.b( here' })));
    assert.equal(find('a.b(', card({ text: 'see axb( here' })), null);
  });
  it('matches the summary alone before the whole card has arrived', () => {
    assert.ok(matchCard(['billing'], summarize(card({ tags: { topic: 'billing' } }), undefined), undefined));
  });
});

describe('highlight', () => {
  it('flags each match, in any case, and keeps the original text', () => {
    assert.deepEqual(highlightParts('Fix the INVOICE fix', ['fix', 'invoice']), [
      { text: 'Fix', hit: true }, { text: ' the ', hit: false }, { text: 'INVOICE', hit: true }, { text: ' ', hit: false }, { text: 'fix', hit: true },
    ]);
  });
  it('returns the text whole when nothing matches or there are no terms', () => {
    assert.deepEqual(highlightParts('plain', []), [{ text: 'plain', hit: false }]);
    assert.deepEqual(highlightParts('plain', ['zzz']), [{ text: 'plain', hit: false }]);
  });
});
