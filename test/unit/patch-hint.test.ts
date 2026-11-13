// A patch that matches nothing names the closest stored lines, so an agent can patch from the real text instead of
// from the payload it remembers sending.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';

function makeInbox() {
  return { inbox: new Inbox(new MemoryStorage(), () => 1_000_000), owner: { token: 'ta', role: 'agent' } satisfies Caller };
}

describe('a patch whose old text is missing', () => {
  it('names the closest stored lines instead of only counting zero', () => {
    const { inbox, owner } = makeInbox();
    inbox.postCard(owner, {
      id: 'c1', agent: 's1', title: 'Plan',
      text: '- **Le « 5 % » n\'existe plus.** Le compte chèques paie 1,25 %.\n- **Frais** : 150 $ par compte.',
    });
    assert.throws(
      () => inbox.patchCard(owner, 'c1', [{ old: '### Point de vigilance : le « 5 % » n\'existe plus', new: 'x' }]),
      (e: unknown) => e instanceof InboxError && e.status === 409
        && /occurs 0 times in text/.test(e.message)
        && e.message.includes('Le « 5 % » n\'existe plus'),
    );
  });

  it('says so when nothing stored shares a word, and points at reading the card', () => {
    const { inbox, owner } = makeInbox();
    inbox.postCard(owner, { id: 'c1', agent: 's1', title: 'Plan', text: 'Use SQLite.' });
    assert.throws(
      () => inbox.patchCard(owner, 'c1', [{ old: 'zzz qqq', new: 'x' }]),
      /no stored line shares a word with it, so read the card/,
    );
  });

  it('does not name lines when the old text is merely repeated', () => {
    const { inbox, owner } = makeInbox();
    inbox.postCard(owner, { id: 'c1', agent: 's1', title: 'Plan', text: 'a = 1\na = 1' });
    assert.throws(() => inbox.patchCard(owner, 'c1', [{ old: 'a = 1', new: 'a = 2' }]), (e: unknown) => e instanceof InboxError
      && e.status === 409 && /occurs 2 times in text, and it must occur once$/.test(e.message));
  });
});
