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

  it('sends the card once, however often the agent reconnects', () => {
    const { inbox, events, connect } = setup();
    inbox.sendCard(owner, { agent: 'claude:s1', text: 'One card, please.' });
    connect('claude:s1');
    connect('claude:s1');
    assert.equal(cardEvents(events).length, 1);
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
