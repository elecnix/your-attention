// An agent subscribes a webhook to the answers to its cards, with a system card the owner approves.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sign } from '../../src/core/hooks.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AnswerEvent, NewCard } from '../../src/core/types.ts';

interface Sent { url: string; headers: Record<string, string>; body: string }

function setup(status: () => number = () => 200) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const sent: Sent[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
    return new Response(null, { status: status() });
  }) as typeof fetch;
  const inbox = new Inbox(new MemoryStorage(), clock.now, undefined, { fetch: fetcher });
  const agent: Caller = { token: 'ta', role: 'agent' };
  const owner: Caller = { token: 'to', role: 'owner' };
  const settle = async (): Promise<void> => { while (inbox.deliveries.size) await Promise.all([...inbox.deliveries]); };
  return { inbox, clock, sent, agent, owner, settle };
}

const subscribe = (agent = 'cli:deploy', headers: Record<string, string> = { Authorization: 'Bearer hook-secret' }): NewCard => ({
  agent, kind: 'system', title: 'Subscribe',
  system: { type: 'subscribe', webhook: { url: 'https://example.com/hooks/abc', headers }, events: ['answer'] },
});

const rejects = (status: number, message: RegExp) => (e: unknown): boolean => e instanceof InboxError && e.status === status && message.test(e.message);

describe('answer webhooks', () => {
  it('asks the owner on a system card, and sends nothing before the owner approves', async () => {
    const { inbox, agent, sent, settle } = setup();
    const r = inbox.subscribe(agent, subscribe());
    assert.ok(r.secret.length >= 32);
    assert.equal(r.subscription.status, 'pending');
    const card = inbox.getCard(r.card.id);
    assert.equal(card.kind, 'system');
    assert.equal(card.agent, 'system');
    assert.match(card.title, /cli:deploy/);
    assert.match(card.text ?? '', /https:\/\/example\.com\/hooks\/abc/);
    assert.match(card.text ?? '', /Authorization/);
    assert.doesNotMatch(JSON.stringify(card), /hook-secret/);
    inbox.postCard(agent, { id: 'c1', agent: 'cli:deploy', title: 'Ship it?' });
    await inbox.answer('c1', { values: { choice: 'yes' } });
    await settle();
    assert.equal(sent.length, 0);
  });

  it('after approval, posts each answer as the agent stream event, signed, with the agent headers, and marks it read', async () => {
    const { inbox, agent, sent, settle } = setup();
    const r = inbox.subscribe(agent, subscribe());
    await inbox.answer(r.card.id, { values: { choice: 'approve' } });
    assert.equal(inbox.listSubscriptions(agent)[0]?.status, 'approved');
    assert.equal(inbox.getCard(r.card.id).closed?.kind, 'resolved');
    inbox.postCard(agent, { id: 'c1', agent: 'cli:deploy', title: 'Ship it?' });
    await inbox.answer('c1', { values: { choice: 'yes' }, comment: 'go' });
    await settle();
    assert.equal(sent.length, 1);
    const call = sent[0]!;
    assert.equal(call.url, 'https://example.com/hooks/abc');
    assert.equal(call.headers['authorization'], 'Bearer hook-secret');
    assert.equal(call.headers['x-your-attention-event'], 'answer');
    assert.equal(call.headers['x-your-attention-signature'], await sign(r.secret, call.body));
    const ev = JSON.parse(call.body) as AnswerEvent;
    assert.equal(ev.type, 'answer');
    assert.equal(ev.card.id, 'c1');
    assert.equal(ev.card.token, undefined);
    assert.equal(ev.answer.comment, 'go');
    assert.equal(call.headers['x-your-attention-delivery'], ev.id);
    assert.equal(inbox.state().states['c1'], 'read');
  });

  it('retries a failed delivery with backoff, on the platform alarm, with the same answer id', async () => {
    let code = 503;
    const { inbox, agent, sent, settle, clock } = setup(() => code);
    const r = inbox.subscribe(agent, subscribe());
    await inbox.answer(r.card.id, { values: { choice: 'approve' } });
    inbox.postCard(agent, { id: 'c1', agent: 'cli:deploy', title: 'Ship it?' });
    await inbox.answer('c1', { values: { choice: 'yes' } });
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(inbox.state().states['c1'], 'answered');
    const retry = inbox.nextDeadline();
    assert.ok(retry !== undefined && retry > clock.now());
    await inbox.deliverAnswers();
    assert.equal(sent.length, 1, 'nothing goes out before the retry time');
    assert.match(inbox.listSubscriptions(agent)[0]?.lastError?.reason ?? '', /503/);
    code = 200;
    clock.advance(retry - clock.now());
    await inbox.deliverAnswers();
    assert.equal(sent.length, 2);
    assert.equal(JSON.parse(sent[1]!.body).id, JSON.parse(sent[0]!.body).id);
    assert.equal(inbox.state().states['c1'], 'read');
    assert.equal(inbox.nextDeadline(), undefined);
  });

  it('sends only the answers to cards of the same agent id and token', async () => {
    const { inbox, agent, sent, settle } = setup();
    const r = inbox.subscribe(agent, subscribe());
    await inbox.answer(r.card.id, { values: { choice: 'approve' } });
    inbox.postCard(agent, { id: 'other-agent', agent: 'cli:other', title: 'q' });
    inbox.postCard({ token: 'tb', role: 'agent' }, { id: 'other-token', agent: 'cli:deploy', title: 'q' });
    await inbox.answer('other-agent', {});
    await inbox.answer('other-token', {});
    await settle();
    assert.equal(sent.length, 0);
  });

  it('stops when the owner denies on the card, when the agent unsubscribes, or when its token goes', async () => {
    const { inbox, agent, owner, sent, settle } = setup();
    const answerCard = async (id: string): Promise<void> => {
      inbox.postCard(agent, { id, agent: 'cli:deploy', title: id });
      await inbox.answer(id, {});
      await settle();
    };
    const a = inbox.subscribe(agent, subscribe());
    await inbox.answer(a.card.id, { values: { choice: 'approve' } });
    // The owner changes the answer on the closed card.
    await inbox.answer(a.card.id, { values: { choice: 'deny' } });
    assert.deepEqual(inbox.listSubscriptions(owner), []);
    await answerCard('after-deny');

    const b = inbox.subscribe(agent, subscribe());
    await inbox.answer(b.card.id, { values: { choice: 'approve' } });
    assert.deepEqual(inbox.systemRequest(agent, { agent: 'cli:deploy', kind: 'system', title: 'Unsubscribe', system: { type: 'unsubscribe' } }), { removed: 1 });
    assert.match(inbox.getCard(b.card.id).closed?.outcome ?? '', /unsubscribed/);
    await answerCard('after-unsubscribe');

    const { token } = await inbox.createToken('deploy script', 'agent');
    const c = inbox.subscribe({ token: token.id, role: 'agent' }, subscribe());
    await inbox.answer(c.card.id, { values: { choice: 'approve' } });
    inbox.revokeToken(token.id);
    assert.match(inbox.getCard(c.card.id).closed?.outcome ?? '', /revoked/);
    assert.deepEqual(inbox.listSubscriptions(owner), []);
    assert.equal(sent.length, 0);
  });

  it('replaces an earlier request from the same agent id and token', () => {
    const { inbox, agent, owner } = setup();
    const a = inbox.subscribe(agent, subscribe());
    inbox.subscribe(agent, subscribe());
    assert.equal(inbox.listSubscriptions(owner).length, 1);
    assert.match(inbox.getCard(a.card.id).closed?.outcome ?? '', /new request/);
  });

  it('refuses a webhook it cannot send safely', () => {
    const { inbox, agent, owner } = setup();
    const withHook = (webhook: unknown, events?: unknown): NewCard => ({ agent: 'a', kind: 'system', title: 's', system: { type: 'subscribe', webhook, events } as never });
    assert.throws(() => inbox.systemRequest(agent, withHook({ url: 'http://example.com/h' })), rejects(400, /https/));
    assert.throws(() => inbox.systemRequest(agent, withHook({ url: 'https://example.com/h', headers: { 'bad name': 'x' } })), rejects(400, /header/));
    assert.throws(() => inbox.systemRequest(agent, withHook({ url: 'https://example.com/h', headers: { 'X-Your-Attention-Signature': 'x' } })), rejects(400, /header/));
    assert.throws(() => inbox.systemRequest(agent, withHook({ url: 'https://example.com/h', headers: { A: 'x\r\nB: y' } })), rejects(400, /header/));
    assert.throws(() => inbox.systemRequest(agent, withHook({ url: 'https://example.com/h' }, ['closed'])), rejects(400, /events/));
    assert.throws(() => inbox.systemRequest(agent, { agent: 'a', kind: 'system', title: 's', system: { type: 'other' } as never }), rejects(400, /subscribe or unsubscribe/));
    assert.throws(() => inbox.subscribe({ token: 'tx', role: 'extension' }, subscribe()), rejects(403, /extension/));
    // A card from a client that sets kind system without a request is refused, so no agent posts as the inbox.
    assert.throws(() => inbox.postCard(agent, { agent: 'a', kind: 'system', title: 'Pair me' }), rejects(400, /system card/));
    assert.deepEqual(inbox.listSubscriptions(owner), []);
  });

  it('serves the routes, and never returns a header value', async () => {
    const { inbox } = setup();
    const ownerSecret = (await inbox.createToken('page', 'owner', { pinExempt: true })).secret;
    const agentSecret = (await inbox.createToken('agent', 'agent')).secret;
    const otherSecret = (await inbox.createToken('other', 'agent')).secret;
    const handle = createHandler(inbox, { heartbeatMs: 50 });
    const call = (secret: string, method: string, route: string, body?: unknown) => handle(new Request(`http://inbox${route}`, {
      method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const posted = await call(agentSecret, 'POST', '/v1/cards', subscribe());
    assert.equal(posted.status, 201);
    const created = await posted.json() as { subscription: { id: string; headers: string[] }; card: { id: string }; secret: string };
    assert.deepEqual(created.subscription.headers, ['Authorization']);
    for (const secret of [ownerSecret, agentSecret]) {
      const text = await (await call(secret, 'GET', '/v1/subscriptions')).text();
      assert.match(text, /Authorization/);
      assert.doesNotMatch(text, /hook-secret/);
      assert.doesNotMatch(text, new RegExp(created.secret));
    }
    assert.deepEqual(await (await call(otherSecret, 'GET', '/v1/subscriptions')).json(), []);
    assert.equal((await call(otherSecret, 'DELETE', `/v1/subscriptions/${created.subscription.id}`)).status, 403);
    assert.doesNotMatch(JSON.stringify(inbox.state()), /hook-secret/);
    const gone = await call(agentSecret, 'POST', '/v1/cards', { agent: 'cli:deploy', kind: 'system', title: 'Unsubscribe', system: { type: 'unsubscribe' } });
    assert.deepEqual(await gone.json(), { removed: 1 });
    // Revoking from the owner removes it too.
    const again = await (await call(agentSecret, 'POST', '/v1/cards', subscribe())).json() as { subscription: { id: string } };
    assert.equal((await call(ownerSecret, 'DELETE', `/v1/subscriptions/${again.subscription.id}`)).status, 200);
    assert.deepEqual(await (await call(ownerSecret, 'GET', '/v1/subscriptions')).json(), []);
  });
});
