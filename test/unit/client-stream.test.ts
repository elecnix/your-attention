// `Client.stream`: a transport that answers with a permanent status is not retried in a hot loop.
// A hosted inbox serves no event stream and says so with 410. Before this test, the client fell back to
// `/v1/stream` forever, retried it every second, and every retry woke the inbox's Durable Object.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';

/** A token in the shape a client sends; the fake inbox never checks it. */
const TOKEN = `aaaaaaaaaaaa.${'a'.repeat(64)}`;

interface FakeInbox {
  url: string;
  hits: string[];
  close(): Promise<void>;
}

/**
 * An inbox that refuses the socket upgrade and answers its event stream with `status`, the way a hosted
 * inbox answers `/v1/stream` with 410. Every request is recorded by path.
 */
async function fakeInbox(status: number): Promise<FakeInbox> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://inbox').pathname;
    hits.push(path);
    if (path === '/v1/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"name":"your-attention","protocol":1}');
      return;
    }
    if (path === '/v1/stream' || path === '/v1/poll') {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"error":"this inbox serves events over the WebSocket at /v1/ws only"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  // A socket that never opens: the client must treat an answer instead of a socket as "no socket here".
  server.on('upgrade', (_req, socket) => { hits.push('/v1/ws'); socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const status of [410]) {
  describe(`a stream answered with ${status}`, () => {
    let inbox: FakeInbox | undefined;
    afterEach(async () => { await inbox?.close(); });

    it('asks for the event stream once, then stops using it', async () => {
      inbox = await fakeInbox(status);
      const client = new Client({ url: inbox.url, token: TOKEN });
      const control = new AbortController();
      const stream = client.stream('pi:test', () => {}, control.signal);
      await sleep(1200);
      control.abort();
      await stream;
      const streams = inbox.hits.filter((h) => h === '/v1/stream').length;
      assert.equal(streams, 1, `the event stream was refused but requested ${streams} times`);
      assert.ok(inbox.hits.length <= 12, `the client made ${inbox.hits.length} requests in 1.2s`);
    });
  });
}

describe('a stream answered with 401', () => {
  let inbox: FakeInbox | undefined;
  afterEach(async () => { await inbox?.close(); });

  it('stops instead of retrying a token the inbox refuses', async () => {
    inbox = await fakeInbox(401);
    const client = new Client({ url: inbox.url, token: TOKEN });
    const control = new AbortController();
    const stream = client.stream('pi:test', () => {}, control.signal);
    stream.catch(() => {});
    const refused = await Promise.race([
      stream.then(() => 'resolved', (e: Error) => e.message),
      sleep(800).then(() => 'still retrying'),
    ]);
    control.abort();
    await stream.catch(() => {});
    assert.match(String(refused), /401/, `expected the client to stop on 401, got ${refused}`);
  });
});
