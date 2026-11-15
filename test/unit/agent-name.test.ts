// The name a guidance card labels an agent row with: what its connection reports, then the name its newest card
// carries, then its id.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CardSummary } from '../../src/core/summary.ts';
import type { Presence } from '../../src/core/types.ts';
import { agentName } from '../../web/queue.js';

/** The two card fields the name reads, since a real card carries many more. */
const card = (agent: string, createdAt: number, name?: string) => ({ agent, createdAt, ...(name ? { origin: { name } } : {}) }) as unknown as CardSummary;
const presence = (name?: string): Record<string, Presence> => ({ 'claude:s1': { agent: 'claude:s1', online: true, lastSeen: 1, ...(name ? { origin: { name } } : {}) } });

describe("an agent's name on the guidance card", () => {
  it('is the name its connection reported, for a session that posted no card at all', () => {
    assert.equal(agentName('claude:s1', [], presence('Rename the retry flag')), 'Rename the retry flag');
  });

  it("comes after the connection's name, which wins over an older card of the same agent", () => {
    const cards = [card('claude:s1', 1, 'A name from a card')];
    assert.equal(agentName('claude:s1', cards, presence('Rename the retry flag')), 'Rename the retry flag');
  });

  it("falls back to the newest card's name when the presence reports none", () => {
    const cards = [card('claude:s1', 1, 'The older name'), card('claude:s1', 5, 'The newest name'), card('pi:s2', 9, 'Another agent')];
    assert.equal(agentName('claude:s1', cards, presence()), 'The newest name');
  });

  it('falls back to the id when neither the presence nor a card carries a name', () => {
    assert.equal(agentName('claude:s1', [card('claude:s1', 1)], presence()), 'claude:s1');
  });

  it('reads no name from the presence of another agent', () => {
    assert.equal(agentName('pi:s2', [], presence('Rename the retry flag')), 'pi:s2');
  });
});
