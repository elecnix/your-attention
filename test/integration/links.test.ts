// Transports, idempotent messages, and the links that offer one inbox in several places.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, type Transport } from '../../src/client.ts';
import type { AgentEvent, PersonPresence } from '../../src/core/types.ts';
import { bridge, relayClient, relayServer } from '../../src/node/links.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

const presence = async (agent: string) =>
  ((await (await h.owner('GET', '/v1/state')).json()) as { presence: Record<string, { online: boolean }> }).presence[agent]?.online;

async function roundTrip(client: Client, agent: string, transport: Transport, id: string): Promise<void> {
  const got: AgentEvent[] = [];
  const stop = new AbortController();
  await client.post({ id, agent, title: `Over ${transport}?` });
  void client.stream(agent, (e) => { got.push(e); }, stop.signal, transport);
  await until(async () => (await presence(agent)) || undefined);
  await h.owner('POST', `/v1/cards/${id}/answer`, { comment: transport });
  const ev = await until(() => got.find((e) => e.type === 'answer'));
  assert.equal(ev.type === 'answer' && ev.answer.comment, transport);
  stop.abort();
}

describe('transports', () => {
  for (const t of ['sse', 'ws', 'poll'] as const) {
    it(`delivers an answer over ${t}`, async () => {
      await roundTrip(new Client({ url: h.server.url, token: h.agentToken }), `agent-${t}`, t, `card-${t}`);
    });
  }

  it('marks a WebSocket agent offline a short grace after it leaves', async () => {
    await until(async () => (await presence('agent-ws')) === false || undefined, 6000);
  });

  it('keeps a long-polling agent online between polls', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const stop = new AbortController();
    void client.stream('poller', () => {}, stop.signal, 'poll');
    await until(async () => (await presence('poller')) || undefined);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(await presence('poller'), true);
    stop.abort();
  });

  it('refuses a WebSocket that never authenticates', async () => {
    const ws = new WebSocket(`${h.server.url.replace('http', 'ws')}/v1/ws?agent=nobody`);
    await new Promise((r) => ws.addEventListener('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong.token' }));
    const code = await new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
    assert.equal(code, 4401);
  });
});

describe('messages over several links', () => {
  it('applies a message once, however often it arrives', async () => {
    const send = () => fetch(`${h.server.url}/v1/cards`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.agentToken}`, 'content-type': 'application/json', 'x-message-id': 'msg-0001-retry' },
      body: JSON.stringify({ id: 'once', agent: 's1', title: 'Posted twice?' }),
    });
    const first = await send();
    const second = await send();
    assert.equal(second.headers.get('x-message-id-replayed'), '1');
    assert.equal(((await first.json()) as { version: number }).version, 1);
    assert.equal(((await second.json()) as { version: number }).version, 1, 'the replay returns the first result');
    const card = (await (await h.owner('GET', '/v1/cards/once')).json()) as { card: { version: number } };
    assert.equal(card.card.version, 1);
  });

  it('moves to the next link when one is down, only to the same inbox', async () => {
    const id = ((await (await fetch(`${h.server.url}/v1/info`)).json()) as { id: string }).id;
    const blind = new Client({ url: 'http://127.0.0.1:9', urls: [h.server.url], token: h.agentToken });
    await assert.rejects(blind.post({ agent: 's1', title: 'Where does this go?' }), /no link answered/, 'without the inbox id, no alternate is trusted');
    const other = await start();
    const wrong = new Client({ url: 'http://127.0.0.1:9', urls: [other.server.url], token: h.agentToken, id });
    await assert.rejects(wrong.post({ agent: 's1', title: 'To another inbox?' }), /no link answered/);
    await other.stop();
    const client = new Client({ url: 'http://127.0.0.1:9', urls: [h.server.url], token: h.agentToken, id });
    const card = await client.post({ agent: 's1', title: 'Through the second link' });
    assert.equal(card.title, 'Through the second link');
    assert.equal(client.url, h.server.url);
  });

  it('counts an answer once when two links deliver it', async () => {
    const b = await bridge({ upstream: h.server.url, port: 0 });
    const client = new Client({ url: b.url, urls: [h.server.url], token: h.agentToken });
    await client.post({ id: 'twice', agent: 'two-links', title: 'Seen once?' });
    const got: AgentEvent[] = [];
    const stop = new AbortController();
    let hellos = 0;
    void client.stream('two-links', (e) => { got.push(e); if (e.type === 'hello') hellos++; }, stop.signal);
    // A second stream of the same client, as when it holds a link through the bridge and one direct.
    void (client as unknown as { overSse(u: string, a: string, d: (e: AgentEvent) => Promise<void>, s: AbortSignal): Promise<void> })
      .overSse(h.server.url, 'two-links', async (e) => { if ((client as unknown as { fresh(e: AgentEvent): boolean }).fresh(e)) got.push(e); if (e.type === 'hello') hellos++; }, stop.signal).catch(() => {});
    await until(() => hellos >= 2 || undefined);
    // The inbox sends the answer to every open stream of the agent; this client hears it on one link.
    await h.owner('POST', '/v1/cards/twice/answer', { comment: 'once' });
    await until(() => got.find((e) => e.type === 'answer'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(got.filter((e) => e.type === 'answer').length, 1);
    stop.abort();
    await b.close();
  });
});

describe('a bridge', () => {
  it('forwards the token of each caller and grants nothing by itself', async () => {
    const b = await bridge({ upstream: h.server.url, port: 0 });
    const bare = await fetch(`${b.url}/v1/cards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'container-1', title: 'From a container' }) });
    assert.equal(bare.status, 401);
    const res = await fetch(`${b.url}/v1/cards`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${h.agentToken}` }, body: JSON.stringify({ agent: 'container-1', title: 'From a container' }) });
    assert.equal(res.status, 201);
    const info = (await (await fetch(`${b.url}/v1/info`)).json()) as { id: string };
    const direct = (await (await fetch(`${h.server.url}/v1/info`)).json()) as { id: string };
    assert.equal(info.id, direct.id, 'one inbox, one identity, on every link');
    await roundTrip(new Client({ url: b.url, token: h.agentToken }), 'via-bridge-ws', 'ws', 'bridge-ws');
    await b.close();
  });
});

describe('a relay', () => {
  it('offers the inbox where it dials out to, with streams, and keeps the relay out of the auth', async () => {
    const relay = await relayServer({ port: 0, host: '127.0.0.1', key: 'relay-test-key' });
    const id = ((await (await fetch(`${h.server.url}/v1/info`)).json()) as { id: string }).id;
    assert.equal((await fetch(`${relay.url}/i/${id}/v1/info`)).status, 404, 'nothing is there before the inbox dials out');
    const link = relayClient({ relay: relay.url, key: 'relay-test-key', inboxId: id, local: h.server.url, log: () => {} });
    await until(async () => (await fetch(`${relay.url}/i/${id}/v1/info`)).status === 200 || undefined);
    assert.equal((await fetch(`${relay.url}/i/${id}/v1/state`)).status, 401, 'the relay holds no token');
    await roundTrip(new Client({ url: `${relay.url}/i/${id}`, token: h.agentToken }), 'via-relay', 'sse', 'relay-sse');
    const page = await fetch(`${relay.url}/i/${id}/`);
    assert.match(await page.text(), /<title>Your Attention<\/title>/);
    const wrongKey = relayClient({ relay: relay.url, key: 'wrong', inboxId: 'other-inbox', local: h.server.url, log: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await fetch(`${relay.url}/i/other-inbox/v1/info`)).status, 404, 'a wrong key registers nothing');
    wrongKey.stop();
    link.stop();
    await relay.close();
  });
});

describe('where the person is', () => {
  it('reports the pages to extensions, and keeps it from agents', async () => {
    const ext = fs.readFileSync(path.join(h.home, 'extension-token'), 'utf8').trim();
    const page = await fetch(`${h.server.url}/v1/events?viewer=tab-test-1`, { headers: { authorization: `Bearer ${h.server.ownerToken}` } });
    await h.owner('POST', '/v1/person/tab-test-1', { focus: 'card-sse', active: true });
    const person = (await (await fetch(`${h.server.url}/v1/person`, { headers: { authorization: `Bearer ${ext}` } })).json()) as PersonPresence;
    assert.deepEqual([person.pages, person.visible, person.focus], [1, true, 'card-sse']);
    assert.equal((await fetch(`${h.server.url}/v1/person`, { headers: { authorization: `Bearer ${h.agentToken}` } })).status, 403);
    await page.body?.cancel();
  });
});
