// A card.created extension that connects screens the cards that arrived while it was away, and nothing older. A first
// connection screens nothing, so the cards the person already had are not closed by findings they never asked for.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HookEvent } from '../../src/core/hooks.ts';
import type { Caller } from '../../src/core/inbox.ts';
import { setup } from './fixture.ts';

const ext: Caller = { token: 'tx', role: 'extension' };
const hook = (calls: HookEvent[], id: string) => calls.find((c): boolean => c.id === id) !== undefined;

function connect(inbox: ReturnType<typeof setup>['inbox'], calls: HookEvent[]): () => void {
  return inbox.connectExtension(ext, { name: 'triage-example', hooks: ['card.created'] }, (e) => calls.push(e));
}

describe('an extension that connects', () => {
  it('leaves the cards the person already had alone on a first connection', () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Which one?' });
    assert.equal(inbox.getCard('old').triage?.state, 'skipped');
    const calls: HookEvent[] = [];
    connect(inbox, calls);
    clock.advance(1_000);
    assert.deepEqual(calls, []);
    assert.equal(inbox.getCard('old').triage?.state, 'skipped');
  });

  it('screens only the cards that arrived while it was away', () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Which one?' });
    const first: HookEvent[] = [];
    const leave = connect(inbox, first);
    leave();
    clock.advance(60_000);
    inbox.postCard(agent, { id: 'away', agent: 's1', title: 'And this one?' });
    assert.equal(inbox.getCard('away').triage?.state, 'skipped');
    const second: HookEvent[] = [];
    connect(inbox, second);
    assert.equal(second.length, 1);
    assert.ok(hook(second, inbox.getCard('away').triage!.request!));
    assert.equal(inbox.getCard('old').triage?.state, 'skipped');
  });

  it('replays a call it missed mid-flight, however old the card is', () => {
    const { inbox, agent } = setup();
    const first: HookEvent[] = [];
    const leave = connect(inbox, first);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
    assert.equal(inbox.getCard('c1').triage?.state, 'pending');
    const request = inbox.getCard('c1').triage!.request!;
    leave();
    const second: HookEvent[] = [];
    connect(inbox, second);
    assert.ok(hook(second, request));
  });
});
