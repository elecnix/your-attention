// A card the person sends to an agent: it goes on that agent's stream, and it waits for a session that connects later.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, SENT_KEEP_MS } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { agent, owner } from './fixture.ts';

const NOW = 1_800_000_000_000;

/** An inbox whose clock a test moves, with the events one agent's connection receives. */
function setup(): { inbox: Inbox; events: AgentEvent[]; connect: (id: string) => void; tick: (ms: number) => void } {
  let clock = NOW;
  const inbox = new Inbox(new MemoryStorage(), () => clock, new MemoryBlobs());
  const events: AgentEvent[] = [];
  return {
    inbox,
    events,
    connect: (id) => { inbox.connect(agent, id, (ev) => events.push(ev)); },
    tick: (ms) => { clock += ms; },
  };
}

const cards = (events: AgentEvent[]): Extract<AgentEvent, { type: 'card' }>[] => events.filter((e): e is Extract<AgentEvent, { type: 'card' }> => e.type === 'card');

describe('a card the person sends to an agent', () => {
  it('reaches the agent\'s stream while the agent is connected, and says that it went', () => {
    const { inbox, events, connect } = setup();
    connect('claude:s1');
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'Please rebase on main before you deploy.' });
    assert.equal(sent.deliveredAt, NOW, 'a connection took the card, so the person reads that it went');
    assert.equal(cards(events).length, 1);
    const [event] = cards(events);
    assert.equal(event?.card.agent, 'claude:s1');
    assert.equal(event?.card.kind, 'ask');
    assert.equal(event?.card.title, 'Please rebase on main before you deploy.');
    assert.equal(event?.card.text, undefined, 'a one-line message reads once');
  });

  it('titles the card with the first line, and keeps the rest as its text', () => {
    const { inbox, events, connect } = setup();
    connect('pi:5f2a');
    inbox.sendCard(owner, { agent: 'pi:5f2a', text: '\nThe deploy needs a decision\n\nPick a region before the run.\n' });
    const [event] = cards(events);
    assert.equal(event?.card.title, 'The deploy needs a decision');
    assert.equal(event?.card.text, 'Pick a region before the run.');
  });

  it('keeps the card for an agent that is offline, and hands it over when its session connects', () => {
    const { inbox, events, connect, tick } = setup();
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'Are you still on the release?' });
    assert.equal(sent.deliveredAt, undefined, 'the inbox says the card waits');
    assert.equal(cards(events).length, 0, 'nothing went, because no connection reports that agent');

    tick(2 * 60 * 60 * 1000);
    connect('claude:s1');
    const [event] = cards(events);
    assert.equal(event?.card.title, 'Are you still on the release?');
    assert.equal(event?.sentAt, NOW, 'the card keeps when the person sent it');
  });

  it('sends the card once, however often the agent reconnects', () => {
    const { inbox, events, connect } = setup();
    inbox.sendCard(owner, { agent: 'claude:s1', text: 'One card, please.' });
    connect('claude:s1');
    connect('claude:s1');
    assert.equal(cards(events).length, 1);
  });

  it('goes on its way to the agent, whatever token its connection reported under', () => {
    const { inbox, events } = setup();
    // The card carries no token of its own, so a session takes what is addressed to its agent id, as guidance does.
    const other = { token: 'tb', role: 'agent' as const };
    inbox.connect(other, 'claude:s1', (ev) => events.push(ev));
    const sent = inbox.sendCard(owner, { agent: 'claude:s1', text: 'A card for the session, not for a token.' });
    assert.equal(sent.deliveredAt, NOW);
    assert.equal(cards(events).length, 1);
  });

  it('refuses a sender that is not the owner, an empty message and a missing agent', () => {
    const { inbox } = setup();
    assert.throws(() => inbox.sendCard(agent, { agent: 'claude:s1', text: 'Hi' }), (e: InboxError) => e.status === 403);
    assert.throws(() => inbox.sendCard(owner, { agent: 'claude:s1', text: '  \n ' }), (e: InboxError) => e.status === 400);
    assert.throws(() => inbox.sendCard(owner, { text: 'Hi' }), (e: InboxError) => e.status === 400);
  });

  it('forgets a card that nobody took after 30 days, so a session that never returns leaves nothing behind', () => {
    const { inbox, events, connect, tick } = setup();
    inbox.sendCard(owner, { agent: 'gone:s1', text: 'Anyone there?' });
    tick(SENT_KEEP_MS);
    inbox.sweep();
    connect('gone:s1');
    assert.equal(cards(events).length, 0);
  });
});
