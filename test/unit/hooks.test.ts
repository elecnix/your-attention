import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deliverWebhook, sign, type HookEvent } from '../../src/core/hooks.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';

type CardCall = Extract<HookEvent, { hook: 'card.created' }>;

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const inbox = new Inbox(new MemoryStorage(), clock.now);
  const agent: Caller = { token: 'ta', role: 'agent' };
  const ext: Caller = { token: 'tx', role: 'extension' };
  const calls: CardCall[] = [];
  return { inbox, clock, agent, ext, calls };
}

describe('the card.created hook', () => {
  it('lets a card through to the person when no extension is connected, and screens it once one connects', () => {
    const { inbox, agent, ext, calls } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    assert.equal(inbox.state().states['c1'], 'open');
    assert.equal(inbox.getCard('c1').triage?.state, 'skipped');
    inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
    assert.equal(calls.length, 1);
    assert.equal(inbox.state().states['c1'], 'in-triage');
  });

  it('passes, holds, or returns a card', () => {
    const { inbox, agent, ext, calls } = setup();
    const back: AgentEvent[] = [];
    inbox.connect(agent, 's1', (e) => back.push(e));
    inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
    for (const id of ['pass', 'hold', 'return']) inbox.postCard(agent, { id, agent: 's1', title: id });
    for (const c of calls) inbox.hookVerdict(ext, c.id, c.card.id as 'pass' | 'hold' | 'return', `because ${c.card.id}`);
    const s = inbox.state().states;
    assert.equal(s['pass'], 'open');
    assert.equal(s['hold'], 'held');
    assert.equal(s['return'], 'closed');
    assert.equal(inbox.getCard('return').closed?.kind, 'returned');
    assert.equal(back.find((e) => e.type === 'returned')?.type === 'returned' && (back.find((e) => e.type === 'returned') as { reason: string }).reason, 'because return');
    assert.equal(inbox.release('hold').triage?.state, 'passed');
  });

  it('waits for every extension on the hook', () => {
    const { inbox, agent, calls } = setup();
    const a: Caller = { token: 'xa', role: 'extension' };
    const b: Caller = { token: 'xb', role: 'extension' };
    inbox.connectExtension(a, { name: 'a', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
    inbox.connectExtension(b, { name: 'b', hooks: ['card.created'] }, () => {});
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    inbox.hookVerdict(a, calls[0]!.id, 'pass', '');
    assert.equal(inbox.state().states['c1'], 'in-triage');
    inbox.hookVerdict(b, calls[0]!.id, 'pass', '');
    assert.equal(inbox.state().states['c1'], 'open');
    assert.throws(() => inbox.hookVerdict({ token: 'other', role: 'extension' }, calls[0]!.id, 'pass', ''), /does not wait/);
  });

  it('applies the declared policy when an extension answers late', () => {
    const { inbox, agent, ext, clock } = setup();
    inbox.connectExtension(ext, { name: 'slow', hooks: ['card.created'], timeoutMs: 5000 }, () => {});
    inbox.postCard(agent, { id: 'open', agent: 's1', title: 'q' });
    clock.advance(5001);
    inbox.sweep();
    assert.equal(inbox.state().states['open'], 'open');
    assert.match(inbox.getCard('open').triage?.reason ?? '', /slow did not answer in time, so the card went through/);
    inbox.connectExtension(ext, { name: 'slow', hooks: ['card.created'], timeoutMs: 5000, policy: 'fail-closed' }, () => {});
    inbox.postCard(agent, { id: 'closed', agent: 's1', title: 'q' });
    clock.advance(5001);
    inbox.sweep();
    assert.equal(inbox.state().states['closed'], 'held');
  });

  it('sends a missed call again when the extension reconnects', () => {
    const { inbox, agent, ext, calls } = setup();
    const close = inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'] }, () => {});
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    close();
    inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
    assert.equal(calls[0]?.card.id, 'c1');
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', '');
    assert.equal(inbox.state().states['c1'], 'open');
  });

  it('keeps agents from registering hooks, and refuses unknown hooks', () => {
    const { inbox, agent, ext } = setup();
    assert.throws(() => inbox.connectExtension(agent, { name: 'x', hooks: ['card.created'] }, () => {}), /extension or owner/);
    assert.throws(() => inbox.connectExtension(ext, { name: 'x', hooks: ['card.deleted' as 'card.created'] }, () => {}), /hooks must name/);
  });
});

describe('the person.changed hook', () => {
  it('tells extensions when the person opens the inbox, looks at a card, or leaves', () => {
    const { inbox, ext, agent, calls } = setup();
    const seen: HookEvent[] = [];
    inbox.connectExtension(ext, { name: 'watch', hooks: ['person.changed', 'card.created'] }, (e) => { seen.push(e); if (e.hook === 'card.created') calls.push(e); });
    assert.equal(inbox.person().pages, 0);
    const close = inbox.subscribePage(() => {}, 'page-1');
    inbox.reportViewer('page-1', { focus: 'c9', active: true });
    inbox.reportViewer('page-1', { active: true });
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    assert.equal(calls[0]?.person.focus, 'c9', 'triage sees what the person is doing');
    inbox.reportViewer('page-1', { visible: false });
    close();
    const changes = seen.filter((e) => e.hook === 'person.changed').map((e) => e.hook === 'person.changed' && e.person);
    assert.deepEqual(changes.map((p) => p && [p.pages, p.visible, p.focus]), [[1, true, null], [1, true, 'c9'], [1, false, null], [0, false, null]]);
  });

  it('combines two people on two pages', () => {
    const { inbox } = setup();
    inbox.subscribePage(() => {}, 'tab-a');
    inbox.subscribePage(() => {}, 'tab-b');
    inbox.reportViewer('tab-a', { visible: false });
    inbox.reportViewer('tab-b', { focus: 'c2', active: true });
    assert.deepEqual([inbox.person().pages, inbox.person().visible, inbox.person().focus], [2, true, 'c2']);
  });
});

describe('the answer.saved hook', () => {
  it('tells observing extensions about each answer', async () => {
    const { inbox, agent, ext, calls } = setup();
    const seen: HookEvent[] = [];
    inbox.connectExtension(ext, { name: 'notify', hooks: ['answer.saved'] }, (e) => seen.push(e));
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    await inbox.answer('c1', { comment: 'yes' });
    const ev = seen.find((c) => c.hook === 'answer.saved');
    assert.ok(ev && ev.hook === 'answer.saved');
    assert.equal(ev.answer.comment, 'yes');
  });

  it('signs each webhook call with HMAC-SHA256', async () => {
    const seen: { headers: Headers; body: string }[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: String(init.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const ok = await deliverWebhook({ id: 'w1', hook: 'answer.saved', url: 'https://example.com/hook', secret: 's3cret' }, { a: 1 }, fake);
    assert.equal(ok, true);
    assert.equal(seen[0]?.headers.get('x-your-attention-signature'), await sign('s3cret', '{"a":1}'));
    assert.match(await sign('s3cret', 'x'), /^sha256=[0-9a-f]{64}$/);
  });
});
