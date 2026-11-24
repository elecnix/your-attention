// The deny ask-pre prints for a question triage stopped, decided from the card alone so no test needs a clock.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { denyReason, stoppedReason } from '../../src/integrations/claude/ask-hook.ts';
import type { Card } from '../../src/core/types.ts';

const card: Card = { id: 'ask-1', agent: 'claude:s', kind: 'ask', dialog: true, title: 'Q', priority: 'now', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] };

describe('the ask-pre deny', () => {
  it('names triage as the sender, gives its reason, and says to ask again with the missing parts', () => {
    const r = denyReason('State the options you weighed.');
    assert.match(r, /Triage stopped this question before the person saw it: State the options you weighed\./);
    assert.match(r, /Ask again with the goal, the options you weighed, and your recommendation\./);
  });

  it('fills in a reason when triage gave none', () => {
    assert.match(denyReason('  '), /it lacked the goal, the options you weighed, the evidence, or a recommendation/);
  });

  it('stops a returned card with the close outcome', () => {
    const returned: Card = { ...card, closed: { kind: 'returned', outcome: 'Too vague.', at: 2 } };
    assert.match(stoppedReason(returned, 'closed') ?? '', /Too vague\./);
  });

  it('stops a held card with triage\'s reason', () => {
    const held: Card = { ...card, triage: { state: 'held', by: 'triage', reason: 'Wait for the goal.', at: 2 } };
    assert.match(stoppedReason(held, 'held') ?? '', /Wait for the goal\./);
  });

  it('lets through a card in triage, one that passed, and one closed for another reason', () => {
    assert.equal(stoppedReason({ ...card, triage: { state: 'pending', at: 2 } }, 'in-triage'), undefined);
    assert.equal(stoppedReason(card, 'open'), undefined);
    assert.equal(stoppedReason({ ...card, closed: { kind: 'resolved', outcome: 'Cancelled.', at: 2 } }, 'closed'), undefined);
  });
});
