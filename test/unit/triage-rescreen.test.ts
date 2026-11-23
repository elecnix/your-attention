// A card.created extension that connects screens the cards that arrived while it was away, and nothing older. A first
// connection screens nothing, so the cards the person already had are not closed by findings they never asked for.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HookEvent } from '../../src/core/hooks.ts';
import type { Caller } from '../../src/core/inbox.ts';
import { setup } from './fixture.ts';

const ext: Caller = { token: 'tx', role: 'extension' };
type CardCall = Extract<HookEvent, { hook: 'card.created' }>;
const hook = (calls: CardCall[], id: string) => calls.find((c): boolean => c.id === id) !== undefined;

function connect(inbox: ReturnType<typeof setup>['inbox'], calls: CardCall[]): () => void {
  return inbox.connectExtension(ext, { name: 'triage-example', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
}

describe('an extension that connects', () => {
  it('leaves the cards the person already had alone on a first connection', () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Which one?' });
    assert.equal(inbox.getCard('old').triage?.state, 'skipped');
    const calls: CardCall[] = [];
    connect(inbox, calls);
    clock.advance(1_000);
    assert.deepEqual(calls, []);
    assert.equal(inbox.getCard('old').triage?.state, 'skipped');
  });

  it('screens only the cards that arrived while it was away', () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Which one?' });
    const first: CardCall[] = [];
    const leave = connect(inbox, first);
    leave();
    clock.advance(60_000);
    inbox.postCard(agent, { id: 'away', agent: 's1', title: 'And this one?' });
    assert.equal(inbox.getCard('away').triage?.state, 'skipped');
    const second: CardCall[] = [];
    connect(inbox, second);
    assert.equal(second.length, 1);
    assert.ok(hook(second, inbox.getCard('away').triage!.request!));
    assert.equal(inbox.getCard('old').triage?.state, 'skipped');
  });

  it('screens a card an agent revised while it was away', () => {
    const { inbox, agent, clock } = setup();
    const first: CardCall[] = [];
    const leave = connect(inbox, first);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
    inbox.hookVerdict(ext, first[0]!.id, 'pass', '');
    leave();
    clock.advance(60_000);
    // A revision keeps the card's creation time, and bumps its version and update time.
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one, exactly?' });
    assert.equal(inbox.getCard('c1').triage?.state, 'skipped');
    const second: CardCall[] = [];
    connect(inbox, second);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.card.id, 'c1');
  });

  it('takes the open cards too when it registers with screen: open', () => {
    const { inbox, agent } = setup();
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Which one?' });
    const calls: CardCall[] = [];
    inbox.connectExtension({ ...ext }, { name: 'triage-example', hooks: ['card.created'], screen: 'open' }, (e) => calls.push(e as CardCall));
    assert.equal(calls.length, 1);
    assert.equal(inbox.getCard('old').triage?.state, 'pending');
  });

  it('refuses a screen mode it does not know', () => {
    const { inbox } = setup();
    assert.throws(() => inbox.connectExtension(ext, { name: 'triage-example', hooks: ['card.created'], screen: 'backlog' as 'new' }, () => {}), /screen must be new or open/);
  });

  it('replays a call it missed mid-flight, however old the card is', () => {
    const { inbox, agent } = setup();
    const first: CardCall[] = [];
    const leave = connect(inbox, first);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
    assert.equal(inbox.getCard('c1').triage?.state, 'pending');
    const request = inbox.getCard('c1').triage!.request!;
    leave();
    const second: CardCall[] = [];
    connect(inbox, second);
    assert.ok(hook(second, request));
  });
});
