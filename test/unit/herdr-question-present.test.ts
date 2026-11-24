// Which question cards the herdr sidecar treats as present, so it posts no second card for the pane.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { questionPresent } from '../../src/integrations/herdr/blocked.ts';
import type { Card } from '../../src/core/types.ts';

const dialog: Card = { id: 'ask-1', agent: 'claude:s', kind: 'ask', dialog: true, title: 'Q', priority: 'now', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] };

describe('a question the herdr sidecar treats as present', () => {
  it('counts a dialog card in triage, held or open, so its pane gets no second card', () => {
    for (const state of ['in-triage', 'held', 'open'] as const) assert.equal(questionPresent(dialog, state), true, state);
  });

  it('lets the sidecar card an orphaned dialog, an answered one, or a card that is not a dialog', () => {
    // An orphaned card's agent stopped connecting an hour ago, so the sidecar's card is the one that can answer in
    // the pane. An answered dialog is closing, and a plain card is no question at all.
    for (const state of ['orphaned', 'answered', 'delivered', 'read', 'closed'] as const) assert.equal(questionPresent(dialog, state), false, state);
    assert.equal(questionPresent({ ...dialog, dialog: undefined }, 'open'), false);
  });
});
