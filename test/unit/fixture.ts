// A stand-in inbox and its callers, for the unit tests that post a card and answer it.
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { Answer } from '../../src/core/types.ts';

export const agent: Caller = { token: 'ta', role: 'agent' };
export const owner: Caller = { token: 'to', role: 'owner' };

/** An inbox in memory, holding one card from `s1` titled "Which one?". */
export function setup(): Inbox {
  const inbox = new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs());
  inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
  return inbox;
}

/** An answer to card c1: the values and comment a test reads back. */
export const answered = (values: Record<string, unknown> = {}, comment = ''): Answer => ({ card: 'c1', version: 1, values, comment, delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [] });
