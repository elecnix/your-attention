// A card the person sends to an agent: it goes on that agent's stream, and it waits for a session that connects later.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, SENT_KEEP_MS } from '../../src/core/inbox.ts';
import type { AgentEvent, SentCard } from '../../src/core/types.ts';
import { agent, cardEvents, NOW, owner, setup } from './fixture.ts';

/** A card sent to an agent with no connection: move the clock by `wait`, let `whileAway` act on the inbox, then let
 * that session connect. Answers the card the send returned, the cards the stream held before the connection, and
 * the ones it received when the session came. */
function sendWhileAway(agentId: string, text: string, wait: number, whileAway: (inbox: Inbox) => void = () => {}): { sent: SentCard; before: number; received: Extract<AgentEvent, { type: 'card' }>[] } {
  const { inbox, events, connect, clock } = setup();
  const sent = inbox.sendCard(owner, { agent: agentId, text });
  const before = cardEvents(events).length;
  clock.advance(wait);
  whileAway(inbox);
  connect(agentId);
  return { sent, before, received: cardEvents(events) };
}

describe('a card the person sends to an agent', () => {
  it('reaches the agent\'s stream while the agent is connected, and says that it went', () => {
    const { inbox, events, connect } = setup();
    connect('claude:s1');
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'Please rebase on main before you deploy.' });
    assert.equal(sent.deliveredAt, NOW, 'a connection took the card, so the person reads that it went');
    assert.equal(cardEvents(events).length, 1);
    const [event] = cardEvents(events);
    assert.equal(event?.card.agent, 'claude:s1');
    assert.equal(event?.card.kind, 'ask');
    assert.equal(event?.card.title, 'Please rebase on main before you deploy.');
    assert.equal(event?.card.text, undefined, 'a one-line message reads once');
  });

  it('gives a card to the agent it names, and not to an id that merely ends the same way', () => {
    const { inbox, events, connect } = setup();
    // A connection key is `token\nagent`, so an agent id that carries a newline must not pass for another agent.
    connect('x\nclaude:s1');
    connect('claude:s1');
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'Rebase before you deploy.' });
    const got = cardEvents(events).filter((e) => e.card.id === sent.id);
    assert.equal(got.length, 1, 'one connection took the card, the one the agent id names');
    assert.equal(got[0]?.card.agent, 'claude:s1');
  });

  it('titles the card with the first line, and keeps the rest as its text', () => {
    const { inbox, events, connect } = setup();
    connect('pi:5f2a');
    inbox.sendCard(owner, { agent: 'pi:5f2a', text: '\nThe deploy needs a decision\n\nPick a region before the run.\n' });
    const [event] = cardEvents(events);
    assert.equal(event?.card.title, 'The deploy needs a decision');
    assert.equal(event?.card.text, 'Pick a region before the run.');
  });

  it('keeps the card for an agent that is offline, and hands it over when its session connects', () => {
    const { sent, before, received } = sendWhileAway('claude:s1', 'Are you still on the release?', 2 * 60 * 60 * 1000);
    assert.equal(sent.deliveredAt, undefined, 'the inbox says the card waits');
    assert.equal(before, 0, 'nothing went, because no connection reports that agent');
    assert.equal(received.length, 1);
    assert.equal(received[0]?.card.title, 'Are you still on the release?');
    assert.equal(received[0]?.sentAt, NOW, 'the card keeps when the person sent it');
  });

  it('sends the card again to each new connection until the agent acknowledges it', () => {
    const { inbox, events, connect, clock } = setup();
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'One card, please.' });
    connect('claude:s1');
    // A send only hands the event to a socket, which the platform may have closed without saying so. The second
    // connection comes later, so an inbox that moved deliveredAt to the resend would fail below.
    clock.advance(1000);
    connect('claude:s1');
    assert.equal(cardEvents(events).length, 2, 'no session acknowledged the card, so the next connection gets it again');
    assert.equal(inbox.sent(sent.id)?.deliveredAt, NOW, 'deliveredAt keeps the first send');
    assert.equal(inbox.sent(sent.id)?.readAt, null, 'no session acknowledged it');
  });

  it('sends nothing more once the agent acknowledged the card', () => {
    const { inbox, events, connect, clock } = setup();
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'One card, please.' });
    connect('claude:s1');
    clock.advance(1000);
    inbox.ackSent(agent, sent.id, { agent: 'claude:s1' });
    assert.equal(inbox.sent(sent.id)?.readAt, NOW + 1000);
    connect('claude:s1');
    assert.equal(cardEvents(events).length, 1);
    // A second acknowledgment, such as a retry, keeps the first time.
    clock.advance(1000);
    inbox.ackSent(agent, sent.id, { agent: 'claude:s1' });
    assert.equal(inbox.sent(sent.id)?.readAt, NOW + 1000);
  });

  it('gives a waiting card to the connection that opens, and not again to the ones already open', () => {
    const { inbox } = setup();
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];
    inbox.connect(agent, 'claude:s1', (ev) => first.push(ev));
    inbox.sendCard(owner, { agent: 'claude:s1', text: 'One card, please.' });
    inbox.connect(agent, 'claude:s1', (ev) => second.push(ev));
    assert.equal(cardEvents(first).length, 1);
    assert.equal(cardEvents(second).length, 1);
  });

  it('refuses an acknowledgment for another agent, an unknown card, or from a page, and keeps sending the card', () => {
    const { inbox, events, connect } = setup();
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'One card, please.' });
    assert.throws(() => inbox.ackSent(agent, sent.id, { agent: 'claude:s2' }), (e: InboxError) => e.status === 404);
    assert.throws(() => inbox.ackSent(agent, 'nope', { agent: 'claude:s1' }), (e: InboxError) => e.status === 404);
    assert.throws(() => inbox.ackSent(owner, sent.id, { agent: 'claude:s1' }), (e: InboxError) => e.status === 403);
    connect('claude:s1');
    assert.equal(cardEvents(events).length, 1);
    assert.equal(inbox.sent(sent.id)?.readAt, null);
  });

  it('counts a card that a stream took before acknowledgments existed as read, so an old message never goes again', () => {
    const { inbox, events, connect } = setup();
    // A record written before the inbox asked for acknowledgments has deliveredAt and no readAt at all.
    const store = (inbox as unknown as { store: { put: (c: string, id: string, v: unknown) => void } }).store;
    const card = inbox.sendCard(owner, { agent: 'claude:s1', text: 'An old message.' });
    store.put('sent', card.id, { id: card.id, agent: 'claude:s1', card: card.card, sentAt: NOW, deliveredAt: NOW });
    connect('claude:s1');
    assert.equal(cardEvents(events).length, 0);
  });

  it('goes on its way to the agent, whatever token its connection reported under', () => {
    const { inbox, events } = setup();
    // The card carries no token of its own, so a session takes what is addressed to its agent id, as guidance does.
    const other = { token: 'tb', role: 'agent' as const };
    inbox.connect(other, 'claude:s1', (ev) => events.push(ev));
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'A card for the session, not for a token.' });
    assert.equal(sent.deliveredAt, NOW);
    assert.equal(cardEvents(events).length, 1);
  });

  it('refuses a sender that is not the owner, an empty message and a missing agent', () => {
    const { inbox } = setup();
    assert.throws(() => inbox.sendCard(agent, { agent: 'claude:s1', text: 'Hi' }), (e: InboxError) => e.status === 403);
    assert.throws(() => inbox.sendCard(owner, { agent: 'claude:s1', text: '  \n ' }), (e: InboxError) => e.status === 400);
    assert.throws(() => inbox.sendCard(owner, { text: 'Hi' }), (e: InboxError) => e.status === 400);
  });

  it('forgets a card that nobody took after 30 days, so a session that never returns leaves nothing behind', () => {
    const { received } = sendWhileAway('gone:s1', 'Anyone there?', SENT_KEEP_MS, (inbox) => inbox.sweep());
    assert.equal(received.length, 0);
  });
});
