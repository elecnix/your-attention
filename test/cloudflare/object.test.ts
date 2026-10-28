// The Durable Object in Node, with stand-ins for the Workers runtime: storage,
// hibernatable sockets and alarms. "Hibernation" builds a new object on the same
// storage and sockets, as the runtime does when it wakes the object.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

class FakeSocket {
  sent: string[] = [];
  attachment: unknown;
  closed: number | undefined;
  lastPong: Date | null = new Date();
  send(t: string) { this.sent.push(t); }
  close(code: number) { this.closed = code; }
  serializeAttachment(a: unknown) { this.attachment = structuredClone(a); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  events() { return this.sent.map((s) => JSON.parse(s) as { type: string; card?: { id: string } }); }
}

const g = globalThis as Record<string, unknown>;
g['WebSocketRequestResponsePair'] = class {};
g['WebSocketPair'] = class { 0 = new FakeSocket(); 1 = new FakeSocket(); };
// Node's Response refuses status 101, which a Worker uses to hand over a WebSocket.
const NodeResponse = Response;
g['Response'] = class extends NodeResponse {
  webSocket: unknown;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.webSocket = init?.webSocket;
  }
};

const { InboxObject, uploadLimit } = await import('../../src/cloudflare/inbox-object.ts');

function runtime() {
  const db = new DatabaseSync(':memory:');
  const sockets: FakeSocket[] = [];
  const blobs = new Map<string, { bytes: Uint8Array; type: string }>();
  let alarm: number | undefined;
  const ctx = {
    id: { toString: () => 'object-1' },
    storage: {
      // Like SqlStorage.exec: the statement runs at once, and the cursor holds its rows.
      sql: { exec: (q: string, ...b: unknown[]) => {
        const stmt = db.prepare(q);
        const rows = /^\s*select/i.test(q) ? stmt.all(...(b as never[])) as Record<string, unknown>[] : (stmt.run(...(b as never[])), []);
        return { toArray: () => rows };
      } },
      setAlarm: async (t: number) => { alarm = t; },
    },
    acceptWebSocket: (ws: FakeSocket) => { sockets.push(ws); },
    getWebSockets: () => sockets.filter((s) => s.closed === undefined),
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: (ws: FakeSocket) => ws.lastPong,
  };
  const env = {
    FILES: {
      put: async (k: string, v: Uint8Array, o: { httpMetadata: { contentType: string } }) => { blobs.set(k, { bytes: v, type: o.httpMetadata.contentType }); },
      get: async (k: string) => { const b = blobs.get(k); return b ? { arrayBuffer: async () => b.bytes.slice().buffer, httpMetadata: { contentType: b.type } } : null; },
      delete: async (k: string) => { blobs.delete(k); },
    },
  };
  const make = () => new InboxObject(ctx as never, env as never);
  return { make, sockets, blobs, alarm: () => alarm };
}

async function call(obj: InstanceType<typeof InboxObject>, method: string, path: string, token?: string, body?: unknown) {
  return obj.fetch(new Request(`https://inbox${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }));
}

describe('the inbox Durable Object', () => {
  it('keeps answering agents across hibernation', async () => {
    const rt = runtime();
    let obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    assert.equal((await call(obj, 'POST', '/v1/cards', owner, { id: 'c1', agent: 's1', title: 'Across hibernation?' })).status, 201);
    const ws = (await obj.fetch(new Request('https://inbox/v1/ws?agent=s1', { headers: { upgrade: 'websocket', authorization: `Bearer ${owner}` } }))) as Response & { webSocket: FakeSocket };
    assert.ok(ws.webSocket);
    const server = rt.sockets[0]!;
    assert.equal(server.events()[0]?.type, 'hello');

    obj = rt.make(); // hibernation: memory is gone, the socket and storage remain
    const state = (await (await call(obj, 'GET', '/v1/state', owner)).json()) as { presence: Record<string, { online: boolean }> };
    assert.equal(state.presence['s1']?.online, true, 'presence survives hibernation');
    await call(obj, 'POST', '/v1/cards/c1/answer', owner, { comment: 'after waking' });
    const answer = server.events().find((e) => e.type === 'answer');
    assert.equal(answer?.card?.id, 'c1');
    assert.ok(rt.alarm(), 'an open socket keeps a heartbeat alarm set');
  });

  it('keeps a socket that authenticated in its first frame authenticated after waking', async () => {
    const rt = runtime();
    let obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    await obj.fetch(new Request('https://inbox/v1/ws?agent=s2', { headers: { upgrade: 'websocket' } }));
    const server = rt.sockets[0]!;
    await obj.webSocketMessage(server as never, JSON.stringify({ type: 'auth', token: owner }));
    await call(obj, 'POST', '/v1/cards', owner, { id: 'c2', agent: 's2', title: 'q' });
    obj = rt.make();
    await call(obj, 'POST', '/v1/cards/c2/answer', owner, {});
    assert.ok(server.events().some((e) => e.type === 'answer'));
  });

  it('closes a socket that never pinged, counting from when it opened', async () => {
    const rt = runtime();
    const obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    await obj.fetch(new Request('https://inbox/v1/ws?agent=quiet', { headers: { upgrade: 'websocket', authorization: `Bearer ${owner}` } }));
    const server = rt.sockets[0]! as FakeSocket & { lastPong: Date | null };
    server.lastPong = null;
    (server.attachment as { connectedAt: number }).connectedAt = Date.now() - 120_000;
    await obj.alarm();
    assert.equal(server.closed, 1001);
  });

  it('closes a socket that stopped answering heartbeats, and the agent goes offline', async () => {
    const rt = runtime();
    const obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    await obj.fetch(new Request('https://inbox/v1/ws?agent=s3', { headers: { upgrade: 'websocket', authorization: `Bearer ${owner}` } }));
    const server = rt.sockets[0]!;
    server.lastPong = new Date(Date.now() - 120_000);
    await obj.alarm();
    assert.equal(server.closed, 1001);
    await new Promise((r) => setTimeout(r, 2100));
    await obj.alarm();
    const state = (await (await call(obj, 'GET', '/v1/state', owner)).json()) as { presence: Record<string, { online: boolean }> };
    assert.equal(state.presence['s3']?.online, false);
  });

  it('keeps file bytes in R2 under the inbox prefix', async () => {
    const rt = runtime();
    const obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    const src = `data:text/markdown;base64,${Buffer.from('# Hello').toString('base64')}`;
    const card = (await (await call(obj, 'POST', '/v1/cards', owner, { id: 'f1', agent: 's1', title: 'q', attachments: [{ src, name: 'hello.md' }] })).json()) as { attachments: { id: string }[] };
    assert.ok([...rt.blobs.keys()][0]?.startsWith('object-1/'));
    const res = await call(obj, 'GET', `/v1/attachments/${card.attachments[0]!.id}`, owner);
    assert.equal(await res.text(), '# Hello');
  });
});

describe('the upload limit setting', () => {
  it('reads a byte count, means no limit when unset, and blocks uploads when it is not a number', () => {
    assert.equal(uploadLimit('104857600'), 104857600);
    assert.equal(uploadLimit(undefined), undefined);
    assert.equal(uploadLimit(''), undefined);
    assert.equal(uploadLimit('0'), 0);
    assert.equal(uploadLimit('100MB'), 0);
    assert.equal(uploadLimit('-5'), 0);
  });
});

describe('the owner token from the deployment', () => {
  it('answers 500 with the reason when the OWNER_TOKEN secret is not a token', async () => {
    const res = await call(runtime().make(), 'POST', '/_init', undefined, { ownerToken: 'a'.repeat(64) });
    assert.equal(res.status, 500);
    assert.match(((await res.json()) as { error: string }).error, /OWNER_TOKEN.*12 hex digits/);
  });
});

describe('sockets that cost the inbox', () => {
  it('closes a socket that answers pings but never signs in', async () => {
    const rt = runtime();
    const obj = rt.make();
    await obj.fetch(new Request('https://inbox/v1/ws?agent=lurker', { headers: { upgrade: 'websocket' } }));
    const server = rt.sockets[0]! as FakeSocket & { lastPong: Date | null };
    server.lastPong = new Date();
    (server.attachment as { connectedAt: number }).connectedAt = Date.now() - 11_000;
    await obj.alarm();
    assert.equal(server.closed, 1001);
  });

  it('closes a socket that sends more frames than its budget', async () => {
    const rt = runtime();
    const obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    await obj.fetch(new Request('https://inbox/v1/ws?agent=chatty', { headers: { upgrade: 'websocket', authorization: `Bearer ${owner}` } }));
    const server = rt.sockets[0]!;
    for (let i = 0; i < 130 && server.closed === undefined; i++) await obj.webSocketMessage(server as never, '{"type":"ack","card":"none"}');
    assert.equal(server.closed, 4429);
  });

  it('carries page events to the owner page over a socket, and refuses other tokens', async () => {
    const rt = runtime();
    const obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    const refused = await obj.fetch(new Request('https://inbox/v1/ws?page=1', { headers: { upgrade: 'websocket' } }));
    assert.equal(refused.status, 401);
    await obj.fetch(new Request('https://inbox/v1/ws?page=1&viewer=tab-1', { headers: { upgrade: 'websocket', cookie: `ya_token=${encodeURIComponent(owner)}` } }));
    assert.equal(rt.sockets.length, 1, 'the owner cookie opens the page socket');
    const page = rt.sockets[0]!;
    await call(obj, 'POST', '/v1/cards', owner, { id: 'c1', agent: 's1', title: 'Seen on the page?' });
    assert.ok(page.sent.some((t: string) => JSON.parse(t).type === 'change'));
  });

  it('serves no event stream, since an open request keeps the object awake', async () => {
    const rt = runtime();
    const obj = rt.make();
    const { owner } = (await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string };
    assert.equal((await call(obj, 'GET', '/v1/events', owner)).status, 410);
  });
});
