// A card.created extension may pass a card with advice for its agent. The person sees the card, and the agent that
// posted it gets the advice as an `advice` event, so it can write its next card better without another round trip.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HookEvent } from '../../src/core/hooks.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { describeAdvice } from '../../src/client.ts';

type CardCall = Extract<HookEvent, { hook: 'card.created' }>;

function setup() {
  const inbox = new Inbox(new MemoryStorage(), () => 1_000_000);
  const agent: Caller = { token: 'ta', role: 'agent' };
  const ext: Caller = { token: 'tx', role: 'extension' };
  const calls: CardCall[] = [];
  const heard: AgentEvent[] = [];
  inbox.connect(agent, 's1', (e) => heard.push(e));
  inbox.connectExtension(ext, { name: 'triage-example', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
  return { inbox, agent, ext, calls, heard };
}

describe('advice on a passed card', () => {
  it('opens the card for the person and sends its agent the advice', () => {
    const { inbox, agent, ext, calls, heard } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Retry the export?' });
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', 'Passed with advice.', 'Say what the export does today.');
    assert.equal(inbox.state().states['c1'], 'open');
    const ev = heard.find((e) => e.type === 'advice');
    assert.ok(ev && ev.type === 'advice');
    assert.equal(ev.advice, 'Say what the export does today.');
    assert.equal(ev.card.id, 'c1');
    assert.equal(ev.by, 'triage-example');
  });

  it('sends no advice event for a pass without advice, or for a return', () => {
    const { inbox, agent, ext, calls, heard } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'One' });
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Two' });
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', 'Fine.');
    inbox.hookVerdict(ext, calls[1]!.id, 'return', 'No goal.', 'ignored on a return');
    assert.equal(heard.filter((e) => e.type === 'advice').length, 0);
  });

  it('keeps a reason and advice of 4000 characters, and cuts them there', () => {
    const { inbox, agent, ext, calls, heard } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'One' });
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Two' });
    inbox.hookVerdict(ext, calls[0]!.id, 'return', 'r'.repeat(4500));
    inbox.hookVerdict(ext, calls[1]!.id, 'pass', '', 'a'.repeat(4500));
    const back = heard.find((e) => e.type === 'returned');
    const advice = heard.find((e) => e.type === 'advice');
    assert.equal(back?.type === 'returned' && back.reason.length, 4000);
    assert.equal(advice?.type === 'advice' && advice.advice.length, 4000);
  });

  it('names triage when the event does not say which extension gave the advice', () => {
    const text = describeAdvice({ type: 'advice', id: 'e1', card: { id: 'c1', title: 'T' } as never, advice: 'A.' } as never);
    assert.match(text, /^Triage let card c1/);
  });

  it('tells the agent the card went to the person, and what the advice is', () => {
    const text = describeAdvice({ type: 'advice', id: 'e1', card: { id: 'c1', title: 'Retry the export?' } as never, advice: 'Say what the export does today.', by: 'triage-example' });
    for (const part of ['triage-example', 'c1', 'Retry the export?', 'Say what the export does today.', 'the person']) assert.ok(text.includes(part), part);
  });

  it('waits for the last extension to pass the card before it sends advice and keeps it as pushback', () => {
    const { inbox, agent, ext, calls, heard, second } = setupTwo();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Retry the export?' });
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', '', 'Say what the export does today.');
    assert.equal(inbox.getCard('c1').triage?.state, 'pending');
    assert.equal(heard.filter((e) => e.type === 'advice').length, 0, 'no advice while the other extension checks the card');
    assert.equal(inbox.getCard('c1').pushback, undefined);
    inbox.hookVerdict(second.caller, second.calls[0]!.id, 'pass', '', 'Name the export job.');
    assert.deepEqual(heard.filter((e) => e.type === 'advice').map((e) => e.type === 'advice' && [e.by, e.advice]), [['triage-example', 'Say what the export does today.'], ['second', 'Name the export job.']]);
    assert.deepEqual(inbox.getCard('c1').pushback?.map((p) => [p.kind, p.by]), [['advice', 'triage-example'], ['advice', 'second']]);
  });

  it('drops the advice when another extension sends the card back', () => {
    const { inbox, agent, ext, calls, heard, second } = setupTwo();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Retry the export?' });
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', '', 'Say what the export does today.');
    inbox.hookVerdict(second.caller, second.calls[0]!.id, 'return', 'No goal.');
    assert.equal(heard.filter((e) => e.type === 'advice').length, 0);
    assert.deepEqual(inbox.getCard('c1').pushback?.map((p) => p.kind), ['returned']);
    assert.equal(inbox.getCard('c1').triage?.advice, undefined, 'the card keeps no advice it never gave');
  });

  it('sends the advice when the card goes through because the other extension did not answer in time', () => {
    const { inbox, agent, ext, calls, heard, tick } = setupTwo();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Retry the export?' });
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', '', 'Say what the export does today.');
    tick(10 * 60_000);
    inbox.sweep();
    assert.equal(inbox.getCard('c1').triage?.state, 'passed');
    assert.equal(heard.filter((e) => e.type === 'advice').length, 1);
    assert.deepEqual(inbox.getCard('c1').pushback?.map((p) => p.kind), ['advice']);
  });
});

/** Two extensions on card.created, so a card passes only when both have passed it. */
function setupTwo() {
  let now = 1_000_000;
  const inbox = new Inbox(new MemoryStorage(), () => now);
  const agent: Caller = { token: 'ta', role: 'agent' };
  const ext: Caller = { token: 'tx', role: 'extension' };
  const calls: CardCall[] = [];
  const heard: AgentEvent[] = [];
  const second = { caller: { token: 'ty', role: 'extension' } as Caller, calls: [] as CardCall[] };
  inbox.connect(agent, 's1', (e) => heard.push(e));
  inbox.connectExtension(ext, { name: 'triage-example', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
  inbox.connectExtension(second.caller, { name: 'second', hooks: ['card.created'] }, (e) => second.calls.push(e as CardCall));
  return { inbox, agent, ext, calls, heard, second, tick: (ms: number) => { now += ms; } };
}
