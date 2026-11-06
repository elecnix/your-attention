// The agent pill a card shows: listening, busy, or a session that cannot receive an answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Presence } from '../../src/core/types.ts';
import { presenceOf, type InboxState } from '../../web/queue.js';

const state = (presence: Record<string, Presence>): InboxState => ({ cards: [], answers: {}, states: {}, presence });
const card = { agent: 'claude:s1', deliver: 'stream' } as const;

describe('the agent pill of a card', () => {
  it('says Channel off when the session discards channel notifications', () => {
    const pill = presenceOf(card, state({ 'claude:s1': { agent: 'claude:s1', online: true, lastSeen: 1, channelOff: true } }));
    assert.equal(pill?.[0], 'off');
    assert.match(pill?.[1] ?? '', /Channel off/);
    assert.match(pill?.[1] ?? '', /development-channels flag/);
  });

  it('says the agent is listening when its channel is on', () => {
    assert.deepEqual(presenceOf(card, state({ 'claude:s1': { agent: 'claude:s1', online: true, lastSeen: 1 } })), ['on', 'Agent listening']);
  });
});
