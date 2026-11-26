// The agent pill a card shows: listening, busy, or a session that cannot receive an answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Presence } from '../../src/core/types.ts';
import type { CardState } from '../../src/core/types.ts';
import { presenceOf, type InboxState } from '../../web/queue.js';

const state = (presence: Record<string, Presence>, states: Record<string, CardState> = {}): InboxState => ({ cards: [], answers: {}, states, presence });
const card = { id: 'c1', agent: 'claude:s1', deliver: 'stream' } as const;
const gone = { 'claude:s1': { agent: 'claude:s1', online: false, lastSeen: 1 } };

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

  it('says the session is not connected, never offline or gone, and adds that another session can take an orphaned card', () => {
    const pill = presenceOf(card, state(gone));
    assert.deepEqual(pill, ['off', 'Not connected: the answer waits until this session reconnects']);
    assert.doesNotMatch(pill?.[1] ?? '', /offline|gone/);
    const orphaned = presenceOf(card, state(gone, { c1: 'orphaned' }));
    assert.equal(orphaned?.[0], 'off');
    assert.match(orphaned?.[1] ?? '', /^Not connected: the answer waits until this session reconnects, and another session can take the card$/);
  });
});
