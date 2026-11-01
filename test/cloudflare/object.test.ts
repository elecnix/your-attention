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

function runtime(extra: Record<string, unknown> = {}) {
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
  const make = () => new InboxObject(ctx as never, { ...env, ...extra } as never);
  return { make, sockets, blobs, alarm: () => alarm };
}

async function call(obj: InstanceType<typeof InboxObject>, method: string, path: string, token?: string, body?: unknown) {
  return obj.fetch(new Request(`https://inbox${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }));
}

/** Create the inbox and return its owner token. */
async function init(obj: InstanceType<typeof InboxObject>): Promise<string> {
  return ((await (await call(obj, 'POST', '/_init', undefined, {})).json()) as { owner: string }).owner;
}

/** Open an agent socket, signed in with a header when `token` is given. */
function openSocket(obj: InstanceType<typeof InboxObject>, query: string, token?: string): Promise<Response> {
  return obj.fetch(new Request(`https://inbox/v1/ws?${query}`, { headers: { upgrade: 'websocket', ...(token ? { authorization: `Bearer ${token}` } : {}) } }));
}

describe('the inbox Durable Object', () => {
  it('shows at most SHOWN_CARDS_LIMIT cards, so the state fits its CPU time', async () => {
    const rt = runtime({ SHOWN_CARDS_LIMIT: '2' });
    const obj = rt.make();
    const owner = await init(obj);
    for (const id of ['c1', 'c2']) assert.equal((await call(obj, 'POST', '/v1/cards', owner, { id, agent: 's', title: id })).status, 201);
    assert.equal((await call(obj, 'POST', '/v1/cards', owner, { id: 'c3', agent: 's', title: 'c3' })).status, 507);
  });

  it('refuses a PIN key it cannot check before it creates the owner token', async () => {
    const rt = runtime();
    const obj = rt.make();
    const res = await call(obj, 'POST', '/_init', undefined, { pin: { key: 'x', salt: 'y', iterations: 1 } });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /^pin: key must be/);
    assert.equal(obj['inbox'].listTokens().length, 0, 'no owner token without an inbox to sign in to');
  });

  it('keeps answering agents across hibernation', async () => {
    const rt = runtime();
    let obj = rt.make();
    const owner = await init(obj);
    assert.equal((await call(obj, 'POST', '/v1/cards', owner, { id: 'c1', agent: 's1', title: 'Across hibernation?' })).status, 201);
    const ws = (await openSocket(obj, 'agent=s1', owner)) as Response & { webSocket: FakeSocket };
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
    const owner = await init(obj);
    await openSocket(obj, 'agent=s2');
    const server = rt.sockets[0]!;
    await obj.webSocketMessage(server as never, JSON.stringify({ type: 'auth', token: owner }));
    await call(obj, 'POST', '/v1/cards', owner, { id: 'c2', agent: 's2', title: 'q' });
    obj = rt.make();
    await call(obj, 'POST', '/v1/cards/c2/answer', owner, {});
    assert.ok(server.events().some((e) => e.type === 'answer'));
  });

  it('sends each socket one hello, however often the object wakes for its heartbeat alarm', async () => {
    const rt = runtime();
    let obj = rt.make();
    const owner = await init(obj);
    // One socket signs in with a header, the other in its first frame, as the CLI does.
    await openSocket(obj, 'agent=w1&instance=i1', owner);
    await openSocket(obj, 'agent=w2&instance=i2');
    const [header, frame] = [rt.sockets[0]!, rt.sockets[1]!];
    await obj.webSocketMessage(frame as never, JSON.stringify({ type: 'auth', token: owner }));
    const hellos = (s: FakeSocket) => s.events().filter((e) => e.type === 'hello').length;
    assert.equal(hellos(header), 1);
    assert.equal(hellos(frame), 1);
    // The alarm wakes a hibernated object every 30 seconds while sockets are open; the sockets stay the same.
    for (let i = 0; i < 3; i++) {
      obj = rt.make();
      await obj.alarm();
    }
    obj = rt.make();
    await obj.webSocketMessage(frame as never, JSON.stringify({ type: 'ping' }));
    assert.equal(hellos(header), 1, 'a wake is not a reconnect, so it sends no hello');
    assert.equal(hellos(frame), 1, 'a wake is not a reconnect, so it sends no hello');
    assert.equal(header.closed, undefined);
    assert.equal(frame.closed, undefined);
    // The sockets still carry answers after the wakes.
    await call(obj, 'POST', '/v1/cards', owner, { id: 'w', agent: 'w2', title: 'still there?' });
    await call(obj, 'POST', '/v1/cards/w/answer', owner, {});
    assert.equal(frame.events().filter((e) => e.type === 'answer').length, 1);
    // A new socket for the same agent is a real connection, so it gets its hello.
    await openSocket(obj, 'agent=w1&instance=i1', owner);
    assert.equal(hellos(rt.sockets[2]!), 1);
  });

  it('closes a socket that never pinged, counting from when it opened', async () => {
    const rt = runtime();
    const obj = rt.make();
    const owner = await init(obj);
    await openSocket(obj, 'agent=quiet', owner);
    const server = rt.sockets[0]! as FakeSocket & { lastPong: Date | null };
    server.lastPong = null;
    (server.attachment as { connectedAt: number }).connectedAt = Date.now() - 120_000;
    await obj.alarm();
    assert.equal(server.closed, 1001);
  });

  it('closes a socket that stopped answering heartbeats, and the agent goes offline', async () => {
    const rt = runtime();
    const obj = rt.make();
    const owner = await init(obj);
    await openSocket(obj, 'agent=s3', owner);
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
    const owner = await init(obj);
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
    await openSocket(obj, 'agent=lurker');
    const server = rt.sockets[0]! as FakeSocket & { lastPong: Date | null };
    server.lastPong = new Date();
    (server.attachment as { connectedAt: number }).connectedAt = Date.now() - 11_000;
    await obj.alarm();
    assert.equal(server.closed, 1001);
  });

  it('closes a socket that sends more frames than its budget', async () => {
    const rt = runtime();
    const obj = rt.make();
    const owner = await init(obj);
    await openSocket(obj, 'agent=chatty', owner);
    const server = rt.sockets[0]!;
    for (let i = 0; i < 130 && server.closed === undefined; i++) await obj.webSocketMessage(server as never, '{"type":"ack","card":"none"}');
    assert.equal(server.closed, 4429);
  });

  it('carries page events to the owner page over a socket, and refuses other tokens', async () => {
    const rt = runtime();
    const obj = rt.make();
    const owner = await init(obj);
    const refused = await openSocket(obj, 'page=1');
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
    const owner = await init(obj);
    assert.equal((await call(obj, 'GET', '/v1/events', owner)).status, 410);
  });
});

describe('fixes from the review of the limits', () => {
  it('answers 401 to a page socket with a malformed cookie', async () => {
    const obj = runtime().make();
    const res = await obj.fetch(new Request('https://inbox/v1/ws?page=1', { headers: { upgrade: 'websocket', cookie: 'ya_token=%' } }));
    assert.equal(res.status, 401);
  });

  it('counts storage the way SQLite measures it, so rewrites with emoji do not inflate it', async () => {
    const { DurableSqlStorage } = await import('../../src/cloudflare/storage.ts');
    const db = new DatabaseSync(':memory:');
    const sql = { exec: (q: string, ...b: unknown[]) => {
      const stmt = db.prepare(q);
      const rows = /^\s*select/i.test(q) ? stmt.all(...(b as never[])) as Record<string, unknown>[] : (stmt.run(...(b as never[])), []);
      return { toArray: () => rows };
    } };
    const store = new DurableSqlStorage(sql);
    const start = store.bytes();
    for (let i = 0; i < 50; i++) { store.put('cards', 'c1', { text: '🙂'.repeat(100) }); store.index('c1', '🙂'.repeat(100)); }
    const fresh = new DurableSqlStorage(sql);
    assert.equal(store.bytes(), fresh.bytes());
    assert.ok(store.bytes() - start < 1000);
  });
});

describe('usage counts of a hosted inbox', () => {
  // The object reads the clock it got when it was built, so the test moves that clock.
  const realNow = Date.now;
  let offset = 0;
  const DAY = 24 * 60 * 60 * 1000;

  function hosted(opts: { telemetry?: boolean } = {}) {
    const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
    const rt = runtime({ MODE: 'hosted', ...(opts.telemetry === false ? {} : { TELEMETRY: { writeDataPoint: (p: never) => { points.push(p); } } }) });
    return { rt, points };
  }

  it('writes each finished day to Analytics Engine with the invite id, and has no off switch', async () => {
    Date.now = () => realNow() + offset;
    try {
      const { rt, points } = hosted();
      const obj = rt.make();
      const { owner } = (await (await call(obj, 'POST', '/_init', undefined, { usage: { invite: '0123456789abcdef' } })).json()) as { owner: string };
      await call(obj, 'POST', '/v1/cards', owner, { id: 'c1', agent: 'private-agent', title: 'A private question' });
      const status = (await (await call(obj, 'GET', '/v1/telemetry', owner)).json()) as { source: string; enabled: boolean; alwaysOn: boolean; notice: boolean; invite: string };
      assert.deepEqual([status.source, status.enabled, status.alwaysOn, status.notice, status.invite], ['hosted', true, true, true, '0123456789abcdef'], 'the page tells the person once');
      assert.equal((await call(obj, 'PUT', '/v1/telemetry', owner, { enabled: false })).status, 400);
      assert.equal(points.length, 0, 'today is not finished');
      offset += DAY;
      await obj.alarm();
      assert.equal(points.length, 1, 'a hosted inbox sends whether or not the page has shown the notice yet');
      assert.deepEqual(points[0]?.indexes, ['0123456789abcdef']);
      assert.equal(points[0]?.blobs[0], 'hosted');
      assert.equal(points[0]?.doubles[0], 1, 'one card');
      assert.doesNotMatch(JSON.stringify(points), /private|"c1"/);
      offset += DAY;
      await obj.alarm();
      assert.equal(points.length, 1, 'a day without activity sends no report');
    } finally {
      Date.now = realNow;
      offset = 0;
    }
  });

  it('keeps counting in an inbox created before the counts had no off switch', async () => {
    Date.now = () => realNow() + offset;
    try {
      const { rt, points } = hosted();
      const obj = rt.make();
      const { owner } = (await (await call(obj, 'POST', '/_init', undefined, { usage: { invite: '0123456789abcdef', enabled: false } })).json()) as { owner: string };
      await call(obj, 'POST', '/v1/cards', owner, { id: 'c1', agent: 'a', title: 'q' });
      offset += DAY;
      await obj.alarm();
      assert.equal(points.length, 1);
    } finally {
      Date.now = realNow;
      offset = 0;
    }
  });

  it('shows no notice where the deployment sends nothing', async () => {
    const single = runtime({ MODE: 'single', TELEMETRY: { writeDataPoint: () => assert.fail('a single-inbox deployment wrote a data point') } });
    const obj = single.make();
    const owner = await init(obj);
    const status = (await (await call(obj, 'GET', '/v1/telemetry', owner)).json()) as { notice: boolean; blocked: string };
    assert.equal(status.notice, false);
    assert.match(status.blocked, /single/);
  });
});
