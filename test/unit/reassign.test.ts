// A card whose agent retired changes hands: the inbox's reassign route, the notice the new holder hears, the orphaned
// card that waits on the person, and what the page says about each.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InboxError } from '../../src/core/inbox.ts';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { presenceOf, reassignments } from '../../web/queue.js';
import { httpInbox, setup } from './fixture.ts';

const reassignedEvents = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'reassigned' }> => e.type === 'reassigned');

describe('reassigning a card whose agent retired', () => {
  it('hands the card to the new agent, keeps who had it and why, and tells the new agent once', () => {
    const { inbox, agent, owner, events, connect } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 'claude:child', title: 'Which schema?' });
    connect('claude:parent');
    const card = inbox.reassign(owner, 'c1', { to: 'claude:parent', why: 'fix-login retired' });
    assert.equal(card.agent, 'claude:parent');
    assert.equal(card.reassignedFrom?.length, 1);
    assert.equal(card.reassignedFrom?.[0]?.from, 'claude:child');
    assert.equal(card.reassignedFrom?.[0]?.to, 'claude:parent');
    assert.equal(card.reassignedFrom?.[0]?.why, 'fix-login retired');
    assert.equal(typeof card.reassignedFrom?.[0]?.at, 'number');
    const told = reassignedEvents(events);
    assert.equal(told.length, 1);
    assert.equal(told[0]?.card.id, 'c1');
    assert.equal(told[0]?.from, 'claude:child');
    assert.equal(told[0]?.why, 'fix-login retired');
    assert.equal(inbox.state().states['c1'], 'open');
  });

  it('keeps the notice for an agent with no stream, and sends it once when that agent connects', () => {
    const { inbox, agent, owner, events, connect } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 'claude:child', title: 'Which schema?' });
    inbox.reassign(owner, 'c1', { to: 'claude:parent', why: 'fix-login retired' });
    assert.equal(reassignedEvents(events).length, 0);
    connect('claude:parent');
    connect('claude:parent');
    assert.equal(reassignedEvents(events).length, 1, 'the second connection hears nothing new');
  });

  it('sends the new agent an answer the retired one never received', async () => {
    const { inbox, agent, owner, events, connect } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 'claude:child', title: 'Which schema?' });
    await inbox.answer('c1', { values: { choice: 'a' } });
    inbox.reassign(owner, 'c1', { to: 'claude:parent', why: 'fix-login retired' });
    connect('claude:parent');
    assert.ok(events.some((e) => e.type === 'answer' && e.card.id === 'c1'));
  });

  it('with no living ancestor, leaves the card where it is, orphaned, and says why', () => {
    const { inbox, agent, owner } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 'claude:child', title: 'Which schema?' });
    inbox.connect(agent, 'claude:child', () => {});
    const card = inbox.reassign(owner, 'c1', { to: null, why: 'fix-login retired' });
    assert.equal(card.agent, 'claude:child');
    assert.equal(card.reassignedFrom?.[0]?.to, undefined);
    const state = inbox.state();
    assert.equal(state.states['c1'], 'orphaned', 'no session reconnects for a retired agent, so the hour does not apply');
    assert.equal(inbox.summaryState().states['c1'], 'orphaned', 'the list reads it from the summary');
    // The same retirement read again changes nothing.
    assert.equal(inbox.reassign(owner, 'c1', { to: null, why: 'fix-login retired' }).reassignedFrom?.length, 1);
    // Another session takes the card, which no longer waits on the person.
    inbox.claim(owner, 'c1', 'claude:other');
    assert.equal(inbox.state().states['c1'], 'open');
  });

  it('refuses anyone but the owner, a closed card, and a card that only shows state', () => {
    const { inbox, agent, owner } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 'claude:child', title: 'q' });
    inbox.postCard(agent, { id: 'c2', agent: 'claude:child', title: 'blocked', deliver: 'none' });
    assert.throws(() => inbox.reassign(agent, 'c1', { to: 'claude:parent', why: 'x retired' }), (e: unknown) => e instanceof InboxError && e.status === 403);
    assert.throws(() => inbox.reassign(owner, 'c1', { to: 'claude:parent', why: '' }), /why must be/);
    assert.throws(() => inbox.reassign(owner, 'c1', { to: 'claude:child', why: 'x retired' }), /already with/);
    assert.throws(() => inbox.reassign(owner, 'c2', { to: 'claude:parent', why: 'x retired' }), /changes hands/);
    inbox.close(agent, 'c1', 'retracted', 'done');
    assert.throws(() => inbox.reassign(owner, 'c1', { to: 'claude:parent', why: 'x retired' }), /closed/);
  });

  it('takes the owner on POST /v1/cards/<id>/reassign, and refuses an agent token', async () => {
    const { call, post, owner, agentA } = await httpInbox();
    await post(agentA, { id: 'c1', agent: 'claude:child', title: 'q' });
    assert.equal((await call('POST', '/v1/cards/c1/reassign', { token: agentA, body: { to: 'claude:parent', why: 'x retired' } })).status, 403);
    const res = await call('POST', '/v1/cards/c1/reassign', { token: owner, body: { to: 'claude:parent', why: 'x retired' } });
    assert.equal(res.status, 200);
    const card = (await res.json()) as Card;
    assert.equal(card.agent, 'claude:parent');
    assert.equal(card.token, undefined, 'the route never sends the token id');
  });
});

describe('what the page says about a card that changed hands', () => {
  const base = { id: 'c1', deliver: 'stream' as const, origin: undefined };
  const named = [
    { ...base, id: 'a', agent: 'claude:child', origin: { name: 'fix-login' } },
    { ...base, id: 'b', agent: 'claude:parent', origin: { name: 'release lead' } },
  ] as never[];

  it('shows each change of hands that found an agent, with both names and why', () => {
    const card = { ...base, agent: 'claude:parent', reassignedFrom: [{ from: 'claude:child', to: 'claude:parent', at: 5, why: 'fix-login retired' }] };
    assert.deepEqual(reassignments(card, named), [{ at: 5, text: 'Reassigned from fix-login to release lead, because fix-login retired' }]);
    // Once the card moved, the agent that posted it may have no card left to name it, and the card's origin names it.
    const alone = { ...card, origin: { name: 'fix-login' } };
    assert.deepEqual(reassignments(alone, named.slice(1)), [{ at: 5, text: 'Reassigned from fix-login to release lead, because fix-login retired' }]);
  });

  it('says on the pill that no agent is left, and why, instead of waiting for a reconnect', () => {
    const card = { ...base, agent: 'claude:child', reassignedFrom: [{ from: 'claude:child', at: 5, why: 'fix-login retired' }] };
    const state = { cards: [], answers: {}, presence: {}, states: { c1: 'orphaned' as const } };
    const pill = presenceOf(card, state);
    assert.equal(pill?.[0], 'off');
    assert.match(pill?.[1] ?? '', /^No agent left: fix-login retired, and no agent above it is alive/);
    assert.doesNotMatch(pill?.[1] ?? '', /reconnects/);
    // The summary the list reads carries the last change only, and says the same.
    assert.deepEqual(presenceOf({ ...base, agent: 'claude:child', lastReassignment: { from: 'claude:child', at: 5, why: 'fix-login retired' } }, state), pill);
    assert.deepEqual(reassignments(card, []), [], 'the pill says it once, and the trace does not repeat it');
  });
});
