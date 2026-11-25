// Searching for a card's id finds that card, on the server (the MCP tool and the HTTP search) and on the page.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import { summarize } from '../../src/core/summary.ts';
import type { Card } from '../../src/core/types.ts';
import { matchCard, searchTerms } from '../../web/search.js';

const owner = { token: '', role: 'owner' } as const;
const agent = { token: 'ta', role: 'agent' } as const;

function inbox(): Inbox {
  const box = new Inbox(new MemoryStorage(), () => 1_800_000_000_000, new MemoryBlobs());
  box.postCard(agent, { id: '6575020d46d5edb3', agent: 's1', title: 'Merge layer 3 of provider access', text: 'Staff set and check a tenant rules.' });
  box.postCard(agent, { id: 'blocked-562a0446', agent: 's1', title: 'Permission backlog is waiting', text: 'Three jobs stopped.' });
  box.postCard(agent, { id: 'c3', agent: 's1', title: 'Something else entirely', text: 'Nothing about ids here.' });
  return box;
}

describe('searching for a card id', () => {
  it('finds the card whose id is typed, even when no word of its text matches', () => {
    const hits = inbox().search('6575020d46d5edb3').results.map((r) => r.card.id);
    assert.deepEqual(hits, ['6575020d46d5edb3']);
  });

  it('finds an id with a dash in it, and a card that carries no matching word', () => {
    const hits = inbox().search('blocked-562a0446').results.map((r) => r.card.id);
    assert.deepEqual(hits, ['blocked-562a0446']);
  });

  it('keeps the word search for text that is not an id', () => {
    const hits = inbox().search('permission').results.map((r) => r.card.id);
    assert.deepEqual(hits, ['blocked-562a0446']);
  });

  it('names no card for an id that does not exist', () => {
    assert.deepEqual(inbox().search('ffffffffffffffff').results, []);
  });
});

describe('matching a card by its id on the page', () => {
  const card = (id: string): Card => ({ id, agent: 's1', kind: 'ask', title: 'Something else', priority: 'now', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] });

  it('matches the card whose id is typed, in any case, and shows no snippet', () => {
    const c = card('6575020d46d5edb3');
    const m = matchCard(searchTerms('6575020D46'), summarize(c, undefined), { card: c });
    assert.ok(m, 'the typed id matches the card');
    assert.equal(m.snippet?.label, 'Id');
  });

  it('does not match a card whose id is not typed', () => {
    const c = card('c3');
    assert.equal(matchCard(searchTerms('6575020d46d5edb3'), summarize(c, undefined), { card: c }), null);
  });
});
