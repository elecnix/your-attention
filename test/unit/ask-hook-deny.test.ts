// The deny ask-pre prints for a question triage stopped, decided from the card alone so no test needs a clock.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { askWaitMs, denyReason, stoppedReason } from '../../src/integrations/claude/ask-hook.ts';
import type { Card } from '../../src/core/types.ts';

const card: Card = { id: 'ask-1', agent: 'claude:s', kind: 'ask', dialog: true, title: 'Q', priority: 'now', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] };

describe('the ask-pre deny', () => {
  it('names triage as the sender, gives its reason, and says to ask again with the missing parts', () => {
    const r = denyReason('State the options you weighed.');
    assert.match(r, /Triage stopped this question before the terminal dialog opened: State the options you weighed\./);
    assert.match(r, /Ask again with the goal, the options you weighed, and your recommendation\./);
  });

  it('fills in a reason when triage gave none', () => {
    assert.match(denyReason('  '), /it lacked the goal, the options you weighed, the evidence, or a recommendation/);
  });

  it('stops a returned card with its close outcome, and a held card with triage\'s reason', () => {
    const returned: Card = { ...card, closed: { kind: 'returned', outcome: 'Too vague.', at: 2 } };
    assert.match(stoppedReason(returned, 'closed') ?? '', /Too vague\./);
    const held: Card = { ...card, triage: { state: 'held', by: 'triage', reason: 'Wait for the goal.', at: 2 } };
    assert.match(stoppedReason(held, 'held') ?? '', /Wait for the goal\./);
  });

  it('does not stop a returned card the person already answered, so the agent is not told to ask again', () => {
    const returned: Card = { ...card, closed: { kind: 'returned', outcome: 'Too vague.', at: 2 } };
    for (const state of ['answered', 'delivered', 'read'] as const) assert.equal(stoppedReason(returned, state), undefined, state);
  });

  it('lets through a card in triage, one that passed, and one closed for another reason', () => {
    assert.equal(stoppedReason({ ...card, triage: { state: 'pending', at: 2 } }, 'in-triage'), undefined);
    assert.equal(stoppedReason(card, 'open'), undefined);
    assert.equal(stoppedReason({ ...card, closed: { kind: 'resolved', outcome: 'Cancelled.', at: 2 } }, 'closed'), undefined);
  });
});

describe('the ask-pre wait', () => {
  it('defaults to 8 seconds, takes a shorter value, caps a longer one, and ignores an empty or unreadable value', () => {
    const key = 'YOUR_ATTENTION_ASK_WAIT_MS';
    const before = process.env[key];
    try {
      delete process.env[key];
      assert.equal(askWaitMs(), 8000);
      process.env[key] = '';
      assert.equal(askWaitMs(), 8000, 'a shell that exports an empty variable must not turn screening off');
      process.env[key] = '  ';
      assert.equal(askWaitMs(), 8000);
      process.env[key] = '500';
      assert.equal(askWaitMs(), 500);
      process.env[key] = '20000';
      assert.equal(askWaitMs(), 8000);
      process.env[key] = 'nope';
      assert.equal(askWaitMs(), 8000);
      process.env[key] = '0';
      assert.equal(askWaitMs(), 0, 'a test may ask for no wait');
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });
});
