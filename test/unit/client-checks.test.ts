// An inbox that takes diagrams and bodies unchecked, as the hosted one does: the posting client checks them first,
// with the laptop inbox's own words, and the page reports what it cannot draw, which sends the card back to its agent.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { checkMermaid } from '../../src/adapters/mermaid.ts';
import { bodyErrors } from '../../src/adapters/openui-body.ts';
import { Client } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';

const BROKEN = '```mermaid\nflowchart TD\n  A -. text .->|label| B\n```';
const BROKEN_BODY = 'root = Card([a, b])\na = TextContent("hi")';

async function inboxAt(host: string, opts: ConstructorParameters<typeof Inbox>[3]) {
  const inbox = new Inbox(new MemoryStorage(), Date.now, undefined, opts);
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const agent = (await inbox.createToken('agents', 'agent')).secret;
  const owner = (await inbox.createToken('page', 'owner', { pinExempt: true })).secret;
  return { inbox, handle, host, agent, owner, client: new Client({ url: `http://${host}`, token: agent }), routes: [] as string[] };
}

type Fake = Awaited<ReturnType<typeof inboxAt>>;
const fakes = new Map<string, Fake>();
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const fake = fakes.get(new URL(req.url).host);
    if (!fake) return realFetch(input, init);
    fake.routes.push(`${req.method} ${new URL(req.url).pathname}`);
    return fake.handle(req);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

async function setup() {
  const hosted = await inboxAt(`hosted-${fakes.size}.test`, { clientChecks: true });
  const laptop = await inboxAt(`laptop-${fakes.size}.test`, { checkDiagram: checkMermaid, checkBody: bodyErrors });
  fakes.set(hosted.host, hosted);
  fakes.set(laptop.host, laptop);
  return { hosted, laptop };
}

const refusal = (p: Promise<unknown>) => p.then(() => assert.fail('the post went through'), (e: Error) => e.message);

describe('checks on the client', () => {
  it('the hosted inbox says it checks nothing, and takes a broken diagram from a raw post', async () => {
    const { hosted, laptop } = await setup();
    const info = (await (await fetch(`http://${hosted.host}/v1/info`)).json()) as { checks: unknown };
    assert.deepEqual(info.checks, { diagrams: false, body: false });
    assert.deepEqual(((await (await fetch(`http://${laptop.host}/v1/info`)).json()) as { checks: unknown }).checks, { diagrams: true, body: true });
    const raw = await fetch(`http://${hosted.host}/v1/cards`, { method: 'POST', headers: { authorization: `Bearer ${hosted.agent}` }, body: JSON.stringify({ id: 'raw', agent: 's', title: 'Raw', text: BROKEN, body: BROKEN_BODY }) });
    assert.equal(raw.status, 201);
  });

  it('refuses a broken diagram or body before it sends the card, with the laptop inbox\'s words', async () => {
    const { hosted, laptop } = await setup();
    for (const card of [{ text: BROKEN }, { recommendation: BROKEN }, { body: BROKEN_BODY }, { body: 'root = Card([d])\nd = Mermaid("flowchart TD\\n  A -. x .->|y| B")' }]) {
      const there = await refusal(laptop.client.post({ id: 'c', agent: 's', title: 'Q', ...card }));
      const here = await refusal(hosted.client.post({ id: 'c', agent: 's', title: 'Q', ...card }));
      assert.equal(here, there);
      assert.match(here, /^POST \/v1\/cards: 400 /);
    }
    assert.deepEqual(hosted.inbox.state().cards, [], 'nothing reached the inbox');
    assert.equal(hosted.routes.filter((r) => r === 'POST /v1/cards').length, 0);
    assert.equal(laptop.routes.includes('POST /v1/preview'), false, 'a laptop inbox checks for itself, so the client sends no preview');
  });

  it('checks the diagrams a template or a widget puts in the body, and the result of a patch', async () => {
    const { hosted } = await setup();
    hosted.inbox.saveTemplate('flow', 'root = Card([d])\nd = Mermaid({{src}})');
    const bad = await refusal(hosted.client.post({ id: 't', agent: 's', title: 'T', template: { name: 'flow', vars: { src: 'flowchart TD\n  A -. x .->|y| B' } } }));
    assert.match(bad, /body, statement d does not parse/);
    await hosted.client.post({ id: 'p', agent: 's', title: 'P', text: '```mermaid\nflowchart TD\n  A --> B\n```' });
    const patched = await refusal(hosted.client.patch('p', [{ old: 'A --> B', new: 'A -. x .->|y| B' }]));
    assert.match(patched, /^POST \/v1\/cards\/p\/patch: 400 The Mermaid diagram in text, the diagram on line 1 does not parse/);
    assert.match(hosted.inbox.getCard('p').text ?? '', /A --> B/, 'the card kept its diagram');
  });

  it('the page reports a diagram it cannot draw, and the card goes back to its agent with mermaid\'s words', async () => {
    const { hosted } = await setup();
    const card = (await (await fetch(`http://${hosted.host}/v1/cards`, { method: 'POST', headers: { authorization: `Bearer ${hosted.agent}` }, body: JSON.stringify({ id: 'd', agent: 's', title: 'Draw?', text: `Look:\n\n${BROKEN}`, body: BROKEN_BODY }) })).json()) as { version: number };
    const heard: AgentEvent[] = [];
    const token = await hosted.inbox.authenticate(hosted.agent);
    hosted.inbox.connect({ token: token?.id ?? '', role: 'agent' }, 's', (ev) => heard.push(ev));
    const report = (as: string, body: unknown) => fetch(`http://${hosted.host}/v1/cards/d/draw-fault`, { method: 'POST', headers: { authorization: `Bearer ${as}` }, body: JSON.stringify(body) });
    const diagram = { source: 'flowchart TD\n  A -. text .->|label| B', error: 'Parse error on line 2:\n...got \'PIPE\'' };
    assert.equal((await report(hosted.agent, { version: card.version, diagrams: [diagram] })).status, 403, 'only the page reports');
    assert.equal((await report(hosted.owner, { version: card.version + 1, diagrams: [diagram] })).status, 409, 'a report on another version changes nothing');
    assert.equal((await report(hosted.owner, { version: card.version, diagrams: [{ source: 'graph LR; X', error: 'no' }] })).status, 400, 'a diagram the card does not show is not its fault');
    const ok = await report(hosted.owner, { version: card.version, renderer: '11.17.2', diagrams: [diagram], body: ['`b` is used but never defined.'] });
    assert.equal(ok.status, 200);
    const back = heard.find((e) => e.type === 'returned');
    assert.ok(back && back.type === 'returned');
    assert.equal(back.by, 'The inbox page');
    assert.match(back.reason, /The Mermaid diagram in text, the diagram on line 3 does not parse, so the page could not draw it, and the inbox sent the card back\. Mermaid 11\.17\.2 says:\nParse error on line 2/);
    assert.match(back.reason, /the page cannot draw all of this body, so the inbox sent the card back:\n- `b` is used but never defined\./);
    assert.equal(hosted.inbox.getCard('d').closed?.kind, 'returned');
    // A second page reports the same card: it is back with its agent already, and nothing more happens.
    assert.equal((await report(hosted.owner, { version: card.version, diagrams: [diagram] })).status, 200);
    assert.equal(heard.filter((e) => e.type === 'returned').length, 1);
  });

  it('leaves an answered card alone', async () => {
    const { hosted } = await setup();
    await (await fetch(`http://${hosted.host}/v1/cards`, { method: 'POST', headers: { authorization: `Bearer ${hosted.agent}` }, body: JSON.stringify({ id: 'a', agent: 's', title: 'A', text: BROKEN }) })).json();
    await hosted.inbox.answer('a', { comment: 'done' });
    const res = await fetch(`http://${hosted.host}/v1/cards/a/draw-fault`, { method: 'POST', headers: { authorization: `Bearer ${hosted.owner}` }, body: JSON.stringify({ version: 1, diagrams: [{ source: 'flowchart TD\n  A -. text .->|label| B', error: 'x' }] }) });
    assert.equal(res.status, 200);
    assert.equal(hosted.inbox.getCard('a').closed, undefined);
  });
});
