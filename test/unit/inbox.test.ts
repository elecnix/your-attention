import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, PRESENCE_GRACE_MS, cardState, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent, PageEvent } from '../../src/core/types.ts';

function setup() {
  let t = 1000;
  const store = new MemoryStorage();
  const inbox = new Inbox(store, () => ++t);
  const agentA: Caller = { token: 'ta', role: 'agent' };
  const agentB: Caller = { token: 'tb', role: 'agent' };
  return { inbox, store, agentA, agentB };
}

describe('cards', () => {
  it('stores a card with defaults and a version', () => {
    const { inbox, agentA } = setup();
    const card = inbox.postCard(agentA, { agent: 's1', title: 'Pick a name' });
    assert.equal(card.priority, 'soon');
    assert.equal(card.version, 1);
    assert.equal(card.deliver, 'stream');
    assert.equal(cardState(card, undefined), 'open');
  });

  it('revises a card in place and keeps its creation time', () => {
    const { inbox, agentA } = setup();
    const first = inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'v1' });
    const second = inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'v2' });
    assert.equal(second.version, 2);
    assert.equal(second.createdAt, first.createdAt);
  });

  it('refuses a card without a title or an agent', () => {
    const { inbox, agentA } = setup();
    assert.throws(() => inbox.postCard(agentA, { agent: 's1', title: ' ' }), InboxError);
    assert.throws(() => inbox.postCard(agentA, { agent: '', title: 'x' }), InboxError);
  });

  it('keeps one client from changing the card of another', () => {
    const { inbox, agentA, agentB } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'mine' });
    assert.throws(() => inbox.postCard(agentB, { id: 'c1', agent: 's2', title: 'theirs' }), /another client/);
    assert.throws(() => inbox.close(agentB, 'c1', 'retracted', 'no'), /another client/);
  });

  it('links a follow-up both ways', () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'first' });
    inbox.postCard(agentA, { id: 'c2', agent: 's1', title: 'second', follows: 'c1' });
    assert.equal(inbox.getCard('c1').followedBy, 'c2');
    assert.equal(inbox.getCard('c2').follows, 'c1');
  });

  it('lets an agent list only its own cards', () => {
    const { inbox, agentA, agentB } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'a' });
    inbox.postCard(agentB, { id: 'c2', agent: 's2', title: 'b' });
    assert.deepEqual(inbox.listCards(agentA).map((x) => x.card.id), ['c1']);
    assert.equal(inbox.listCards({ token: 'o', role: 'owner' }).length, 2);
  });
});

describe('delivery', () => {
  it('delivers an answer at once to the listening agent, then marks it read on ack', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    const got: AgentEvent[] = [];
    inbox.connect(agentA, 's1', (ev) => got.push(ev));
    const saved = await inbox.answer('c1', { values: { choice: 'o1' }, comment: ' ok ' });
    assert.equal(saved.comment, 'ok');
    assert.ok(saved.deliveredAt);
    const ev = got.find((e) => e.type === 'answer');
    assert.ok(ev && ev.type === 'answer');
    assert.equal(ev.card.token, undefined, 'the token id never leaves the inbox');
    assert.equal(cardState(inbox.getCard('c1'), saved), 'delivered');
    const read = inbox.ack(agentA, 'c1');
    assert.ok(read.readAt);
  });

  it('keeps an answer for an offline agent and delivers it when the session returns', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    const saved = await inbox.answer('c1', {});
    assert.equal(saved.deliveredAt, null);
    assert.equal(inbox.deadLetters().length, 1);
    const got: AgentEvent[] = [];
    inbox.connect(agentA, 's1', (ev) => got.push(ev));
    assert.equal(got.filter((e) => e.type === 'answer').length, 1);
    assert.equal(inbox.deadLetters().length, 0);
  });

  it('never sends an answer to another agent, or to another client with the same agent name', async () => {
    const { inbox, agentA, agentB } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    const other: AgentEvent[] = [];
    inbox.connect(agentA, 's2', (ev) => other.push(ev));
    inbox.connect(agentB, 's1', (ev) => other.push(ev));
    await inbox.answer('c1', {});
    assert.equal(other.filter((e) => e.type === 'answer').length, 0);
  });

  it('hands an unclaimed answer to a successor agent', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 'old', title: 'q' });
    await inbox.answer('c1', {});
    const got: AgentEvent[] = [];
    inbox.connect(agentA, 'new', (ev) => got.push(ev));
    inbox.claim(agentA, 'c1', 'new');
    assert.equal(got.filter((e) => e.type === 'answer').length, 1);
  });

  it('marks an agent offline a short grace after its last stream closes', () => {
    let t = 0;
    const inbox = new Inbox(new MemoryStorage(), () => t);
    const agentA: Caller = { token: 'ta', role: 'agent' };
    const close1 = inbox.connect(agentA, 's1', () => {});
    const close2 = inbox.connect(agentA, 's1', () => {});
    close1();
    close2();
    t += PRESENCE_GRACE_MS - 1;
    inbox.sweep();
    assert.equal(inbox.isOnline('s1'), true, 'a reconnect inside the grace keeps the agent online');
    t += 1;
    inbox.sweep();
    assert.equal(inbox.isOnline('s1'), false);
  });

  it('keeps an agent online across a quick reconnect, such as the next long-poll', () => {
    let t = 0;
    const inbox = new Inbox(new MemoryStorage(), () => t);
    const agentA: Caller = { token: 'ta', role: 'agent' };
    inbox.connect(agentA, 's1', () => {})();
    t += 500;
    inbox.connect(agentA, 's1', () => {});
    t += PRESENCE_GRACE_MS * 2;
    inbox.sweep();
    assert.equal(inbox.isOnline('s1'), true);
  });

  it('force-sends an unread answer again', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    const got: AgentEvent[] = [];
    inbox.connect(agentA, 's1', (ev) => got.push(ev));
    await inbox.answer('c1', {});
    const forced = inbox.force('c1');
    assert.equal(forced.delivery, 'force');
    assert.ok(forced.forcedAt);
    assert.equal(got.filter((e) => e.type === 'answer').length, 2);
  });

  it('keeps earlier answers when the person answers again', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    await inbox.answer('c1', { comment: 'one' });
    const second = await inbox.answer('c1', { comment: 'two' });
    assert.deepEqual(second.previous.map((p) => p.comment), ['one']);
  });

  it('marks everyone offline after a restart', () => {
    const { store, agentA } = setup();
    const first = new Inbox(store);
    first.connect(agentA, 's1', () => {});
    assert.equal(new Inbox(store).isOnline('s1'), false);
  });
});

describe('closing', () => {
  it('records who closed the card and why', () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    const closed = inbox.close(agentA, 'c1', 'self-answered', 'Found it in the docs.');
    assert.equal(closed.closed?.kind, 'self-answered');
    assert.equal(cardState(closed, undefined), 'closed');
  });

  it('refuses a conditional close once the person answered', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    await inbox.answer('c1', {});
    assert.throws(() => inbox.close(agentA, 'c1', 'answered-in-terminal', 'x', true), (e: unknown) => e instanceof InboxError && e.status === 409);
  });

  it('still delivers a reply the person sends after the agent closed the card', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    inbox.close(agentA, 'c1', 'retracted', 'Not needed.');
    const got: AgentEvent[] = [];
    inbox.connect(agentA, 's1', (ev) => got.push(ev));
    const a = await inbox.answer('c1', { comment: 'one more thing' });
    assert.equal(cardState(inbox.getCard('c1'), a), 'delivered');
    assert.equal(got.filter((e) => e.type === 'answer').length, 1);
  });

  it('brings a card back with an agent reply', () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    inbox.reply(agentA, 'c1', 'Here is the diff you asked for.');
    assert.equal(inbox.getCard('c1').replies[0]?.seenAt, null);
    inbox.seen('c1');
    assert.ok(inbox.getCard('c1').replies[0]?.seenAt);
  });
});

describe('pairing', () => {
  it('mints a token once the person approves the system card', async () => {
    const { inbox } = setup();
    const p = inbox.requestPairing('laptop', 'agent');
    assert.match(p.code, /^\d{6}$/);
    const card = inbox.getCard(`pair-${p.id}`);
    assert.equal(card.kind, 'system');
    assert.ok(card.text?.includes(p.code));
    assert.equal(inbox.collectPairing(p.id).status, 'pending');
    await inbox.answer(card.id, { values: { choice: 'approve' } });
    const got = inbox.collectPairing(p.id);
    assert.equal(got.status, 'approved');
    const token = await inbox.authenticate(got.token);
    assert.equal(token?.role, 'agent');
    assert.equal(inbox.collectPairing(p.id).token, undefined, 'the secret is handed out once');
    assert.equal(inbox.getCard(card.id).closed?.kind, 'resolved');
  });

  it('mints one token when the person approves twice at once', async () => {
    const { inbox } = setup();
    const p = inbox.requestPairing('laptop', 'agent');
    await Promise.all([
      inbox.answer(`pair-${p.id}`, { values: { choice: 'approve' } }),
      inbox.answer(`pair-${p.id}`, { values: { choice: 'approve' } }),
    ]);
    assert.equal(inbox.listTokens().length, 1);
  });

  it('mints nothing when the person denies', async () => {
    const { inbox } = setup();
    const p = inbox.requestPairing('phone', 'owner');
    await inbox.answer(`pair-${p.id}`, { values: { choice: 'deny' } });
    assert.deepEqual(inbox.collectPairing(p.id), { status: 'denied' });
    assert.equal(inbox.listTokens().length, 0);
  });

  it('limits how many requests can wait', () => {
    const { inbox } = setup();
    for (let i = 0; i < 5; i++) inbox.requestPairing(`c${i}`, 'agent');
    assert.throws(() => inbox.requestPairing('one too many', 'agent'), /too many/);
  });

  it('keeps agents from posting as the system', () => {
    const { inbox, agentA } = setup();
    assert.throws(() => inbox.postCard(agentA, { agent: 'system', title: 'Pair me' }), /reserved/);
  });

  it('expires a request nobody answered', () => {
    let t = 0;
    const inbox = new Inbox(new MemoryStorage(), () => t);
    const p = inbox.requestPairing('old', 'agent');
    t = 11 * 60 * 1000;
    inbox.sweep();
    assert.equal(inbox.collectPairing(p.id).status, 'denied');
  });

  it('rejects a wrong or revoked secret', async () => {
    const { inbox } = setup();
    const { token, secret } = await inbox.createToken('x', 'agent');
    assert.equal(await inbox.authenticate(`${token.id}.wrong`), undefined);
    inbox.revokeToken(token.id);
    assert.equal(await inbox.authenticate(secret), undefined);
  });
});

describe('pages', () => {
  it('tells pages about each change', async () => {
    const { inbox, agentA } = setup();
    const events: PageEvent[] = [];
    inbox.subscribePage((e) => events.push(e));
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'q' });
    await inbox.answer('c1', {});
    assert.ok(events.filter((e) => e.type === 'change' && e.card === 'c1').length >= 2);
  });

  it('searches card text and answers', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'c1', agent: 's1', title: 'Which database?', text: 'Postgres or SQLite' });
    await inbox.answer('c1', { comment: 'SQLite for the laptop build' });
    assert.equal(inbox.search('laptop')[0]?.card.id, 'c1');
    assert.equal(inbox.search('nothing-like-this').length, 0);
  });
});

describe('an answer delivered to a process that never read it', () => {
  it('goes again to the next process of the same agent, and never twice to the same process', async () => {
    const { inbox, agentA } = setup();
    inbox.postCard(agentA, { id: 'r1', agent: 's1', title: 'q' });
    const old: AgentEvent[] = [];
    const closeOld = inbox.connect(agentA, 's1', (ev) => old.push(ev), 'proc-1');
    await inbox.answer('r1', { values: { choice: 'o1' } });
    assert.equal(old.filter((e) => e.type === 'answer').length, 1);
    closeOld();
    // The same process reconnects after a network drop: it already has the answer.
    const again: AgentEvent[] = [];
    const closeAgain = inbox.connect(agentA, 's1', (ev) => again.push(ev), 'proc-1');
    assert.equal(again.filter((e) => e.type === 'answer').length, 0);
    closeAgain();
    // A restarted session is a new process: it gets the unread answer.
    const fresh: AgentEvent[] = [];
    inbox.connect(agentA, 's1', (ev) => fresh.push(ev), 'proc-2');
    const ev = fresh.find((e) => e.type === 'answer');
    assert.ok(ev && ev.type === 'answer' && ev.card.id === 'r1');
    inbox.ack(agentA, 'r1');
    const later: AgentEvent[] = [];
    inbox.connect(agentA, 's1', (e) => later.push(e), 'proc-3');
    assert.equal(later.filter((e) => e.type === 'answer').length, 0, 'a read answer is never sent again');
  });
});
