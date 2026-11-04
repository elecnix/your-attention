// A stand-in inbox and its callers, for the unit tests that post a card and answer it.
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';

export const agent: Caller = { token: 'ta', role: 'agent' };
export const owner: Caller = { token: 'to', role: 'owner' };

/** An inbox in memory, holding one card from `s1` titled "Which one?". */
export function setup(): Inbox {
  const inbox = new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs());
  inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
  return inbox;
}
