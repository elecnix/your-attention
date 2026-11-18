// A session renamed after it connected: its connection reports the new name, and the presence row the agent list and
// its search read takes it, without a reconnect. A name that did not change sends nothing.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { Client } from '../../src/client.ts';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { agentSocket } from '../../src/core/socket.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { Origin, PageEvent } from '../../src/core/types.ts';

function setup() {
  let t = 1000;
  const inbox = new Inbox(new MemoryStorage(), () => ++t);
  const agentA: Caller = { token: 'ta', role: 'agent' };
  const events: PageEvent[] = [];
  inbox.subscribePage((ev) => { events.push(ev); });
  return { inbox, agentA, events };
}

const presenceEvents = (events: PageEvent[]): PageEvent[] => events.filter((e) => e.type === 'presence');

describe('the inbox takes a new origin from a live connection', () => {
  it('replaces the name on the presence row and tells the pages', () => {
    const { inbox, agentA, events } = setup();
    inbox.connect(agentA, 's1', () => {}, undefined, { origin: { harness: 'claude-code', session: 's1', name: 'Cross-platform agent card review tools', herdrPane: 'w1:p1' } });
    events.length = 0;
    assert.equal(inbox.reportOrigin(agentA, 's1', { harness: 'claude-code', session: 's1', name: 'your-attention orchestrator', herdrPane: 'w1:p1' }), true);
    assert.equal(inbox.state().presence['s1']?.origin?.name, 'your-attention orchestrator');
    assert.equal(inbox.isOnline('s1'), true);
    assert.deepEqual(presenceEvents(events), [{ type: 'presence', agent: 's1', online: true }]);
  });

  it('changes nothing and tells nobody when the origin is the one it keeps', () => {
    const { inbox, agentA, events } = setup();
    inbox.connect(agentA, 's1', () => {}, undefined, { origin: { name: 'release prep', cwd: '/src/app' } });
    events.length = 0;
    // A card-only field such as the directory is not kept, so it does not make the origin differ.
    assert.equal(inbox.reportOrigin(agentA, 's1', { name: 'release prep', cwd: '/elsewhere' }), false);
    assert.deepEqual(presenceEvents(events), []);
  });

  it('refuses an origin for an agent this token has no connection for', () => {
    const { inbox, agentA } = setup();
    inbox.connect({ token: 'tb', role: 'agent' }, 's1', () => {}, undefined, { origin: { name: 'mine' } });
    assert.throws(() => inbox.reportOrigin(agentA, 's1', { name: 'stolen' }), InboxError);
    assert.throws(() => inbox.reportOrigin(agentA, 's2', { name: 'nobody' }), InboxError);
    assert.equal(inbox.state().presence['s1']?.origin?.name, 'mine');
  });

  it('ignores what is not an origin', () => {
    const { inbox, agentA } = setup();
    inbox.connect(agentA, 's1', () => {}, undefined, { origin: { name: 'mine' } });
    assert.equal(inbox.reportOrigin(agentA, 's1', 'a page address'), false);
    assert.equal(inbox.state().presence['s1']?.origin?.name, 'mine');
  });
});

describe('an agent socket', () => {
  it('takes an origin frame and keeps the origin it carries', async () => {
    const { inbox, agentA } = setup();
    const sent: string[] = [];
    const sock = agentSocket(inbox, 's1', { send: (t) => sent.push(t), close: () => {} }, agentA, undefined, { origin: { name: 'old' } });
    assert.deepEqual(sock.origin, { name: 'old' });
    await sock.message(JSON.stringify({ type: 'origin', origin: { name: 'new' } }));
    assert.equal(inbox.state().presence['s1']?.origin?.name, 'new');
    // A Durable Object rebuilds the connection from this after it wakes, so the rename survives hibernation.
    assert.deepEqual(sock.origin, { name: 'new' });
  });
});

/** An inbox that accepts any agent socket, says hello, and records each frame the client sends. */
async function socketInbox(): Promise<{ url: string; frames: Array<Record<string, unknown>>; urls: string[]; close(): Promise<void> }> {
  const frames: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    urls.push(req.url ?? '');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (m) => frames.push(JSON.parse(String(m)) as Record<string, unknown>));
      ws.send(JSON.stringify({ type: 'hello', agent: 's1', version: 1, guidance: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    frames,
    urls,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a stream whose origin can change', () => {
  it('sends the new origin over its socket once, and nothing while it stays the same', async () => {
    const inbox = await socketInbox();
    const stop = new AbortController();
    let name = 'Cross-platform agent card review tools';
    const origin = (): Origin => ({ harness: 'claude-code', session: 's1', name });
    try {
      const client = new Client({ url: inbox.url, token: `aaaaaaaaaaaa.${'a'.repeat(64)}` });
      void client.stream('s1', () => {}, stop.signal, 'auto', { origin, originEveryMs: 20 });
      for (let i = 0; i < 100 && !inbox.frames.length; i++) await sleep(10);
      // The address carries the origin at connect, so the first beats have nothing new to say.
      assert.match(decodeURIComponent(inbox.urls[0] ?? ''), /Cross-platform agent card review tools/);
      await sleep(120);
      assert.deepEqual(inbox.frames.filter((f) => f['type'] === 'origin'), []);
      name = 'your-attention orchestrator';
      for (let i = 0; i < 100 && !inbox.frames.some((f) => f['type'] === 'origin'); i++) await sleep(10);
      await sleep(120);
      assert.deepEqual(inbox.frames.filter((f) => f['type'] === 'origin'), [{ type: 'origin', origin: { harness: 'claude-code', session: 's1', name: 'your-attention orchestrator' } }]);
    } finally {
      stop.abort();
      await inbox.close();
    }
  });
});

/** An inbox whose link carries no socket, so the client falls back to the event stream, which stays open. */
async function streamInbox(): Promise<{ url: string; streams: string[]; close(): Promise<void> }> {
  const streams: string[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://inbox');
    if (u.pathname === '/v1/info') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":"your-attention","protocol":1}'); return; }
    if (u.pathname === '/v1/stream') {
      streams.push(u.searchParams.get('origin') ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: beat\ndata: {"type":"beat"}\n\n');
      open.add(res);
      res.on('close', () => open.delete(res));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    streams,
    close: async () => {
      for (const r of open) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('an event stream whose origin can change', () => {
  it('opens a new stream that carries the new origin, and keeps the one it has while the origin stays', async () => {
    const inbox = await streamInbox();
    const stop = new AbortController();
    let name = 'old name';
    try {
      const client = new Client({ url: inbox.url, token: `aaaaaaaaaaaa.${'a'.repeat(64)}` });
      void client.stream('s1', () => {}, stop.signal, 'auto', { origin: () => ({ name }), originEveryMs: 20 });
      for (let i = 0; i < 200 && !inbox.streams.length; i++) await sleep(10);
      await sleep(120);
      assert.deepEqual(inbox.streams.map((o) => JSON.parse(o) as unknown), [{ name: 'old name' }]);
      name = 'new name';
      for (let i = 0; i < 200 && inbox.streams.length < 2; i++) await sleep(10);
      await sleep(120);
      assert.deepEqual(inbox.streams.map((o) => JSON.parse(o) as unknown), [{ name: 'old name' }, { name: 'new name' }]);
    } finally {
      stop.abort();
      await inbox.close();
    }
  });
});
