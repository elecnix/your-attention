// The Cloudflare build as it would run when deployed: `wrangler dev` runs the Worker,
// the Durable Objects, R2 and KV locally in workerd, in hosted mode with invite codes.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { Client } from '../../src/client.ts';
import type { AgentEvent } from '../../src/core/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-wrangler-'));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
let dev: ChildProcess;
let base = '';

const freePort = (): Promise<number> => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); });
});

before(async () => {
  // An invite code with two uses, as the operator would add with `wrangler kv key put`.
  // A .cmd file runs only through a shell on Windows.
  const shell = process.platform === 'win32';
  const seed = spawnSync(WRANGLER, ['kv', 'key', 'put', 'invite:test-code-0123456789ab', '2', '--binding', 'INVITES', '--local', '--persist-to', persist], { cwd: ROOT, env, encoding: 'utf8', shell });
  assert.equal(seed.status, 0, seed.stderr);
  const port = await freePort();
  dev = spawn(WRANGLER, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--var', 'MODE:hosted', '--var', 'UPLOAD_LIMIT_BYTES:150000', '--var', 'INBOX_ID_SECRET:test-address-key', '--persist-to', persist, '--show-interactive-dev-session=false'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell });
  let out = '';
  dev.stdout?.on('data', (d) => { out += String(d); });
  dev.stderr?.on('data', (d) => { out += String(d); });
  base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 90_000;
  for (;;) {
    if (/Ready on/.test(out)) break;
    if (Date.now() > end || dev.exitCode !== null) throw new Error(`wrangler dev did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 300));
  }
});

after(() => {
  dev?.kill();
  fs.rmSync(persist, { recursive: true, force: true });
});

let inbox = '';
let owner = '';
let agent = '';

async function until<T>(check: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('the hosted Cloudflare build', () => {
  it('creates an inbox with an invite code, and refuses one that is used up', async () => {
    assert.match(await (await fetch(`${base}/`)).text(), /Create my inbox/);
    assert.equal((await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'wrong' }) })).status, 403);
    const res = await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'test-code-0123456789ab' }) });
    assert.equal(res.status, 201);
    const { url, login } = (await res.json()) as { url: string; login: string };
    assert.match(url, /\/i\/[0-9a-f]{32}\/$/);
    inbox = url.replace(/\/$/, '');
    owner = decodeURIComponent(login.split('#token=')[1] ?? '');
    assert.equal((await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'test-code-0123456789ab' }) })).status, 201);
    assert.equal((await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'test-code-0123456789ab' }) })).status, 403, 'the code had two uses');
  });

  it('redeems a one-use code once when requests race for it', async () => {
    const seed = spawnSync(WRANGLER, ['kv', 'key', 'put', 'invite:race-code-0123456789ab', '1', '--binding', 'INVITES', '--local', '--persist-to', persist], { cwd: ROOT, env, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.equal(seed.status, 0, seed.stderr);
    // The running dev server reads KV from the same folder, so it sees the new code.
    const all = await Promise.all(Array.from({ length: 6 }, () => fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'race-code-0123456789ab' }) })));
    assert.equal(all.filter((r) => r.status === 201).length, 1);
  });

  it('asks about usage counts on the landing page, and ties them to the invite id, never the code', async () => {
    assert.match(await (await fetch(`${base}/`)).text(), /Send usage counts/);
    const seed = spawnSync(WRANGLER, ['kv', 'key', 'put', 'invite:usage-code-0123456789ab', '3', '--binding', 'INVITES', '--local', '--persist-to', persist], { cwd: ROOT, env, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.equal(seed.status, 0, seed.stderr);
    const make = async (body: object) => {
      const made = (await (await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'usage-code-0123456789ab', ...body }) })).json()) as { url: string; login: string };
      const token = decodeURIComponent(made.login.split('#token=')[1] ?? '');
      return (await (await fetch(`${made.url}v1/telemetry`, { headers: { authorization: `Bearer ${token}` } })).json()) as { enabled: boolean; notice: boolean; invite: string; source: string; blocked: string | null };
    };
    const on = await make({ usage: true });
    assert.deepEqual([on.enabled, on.notice, on.source, on.blocked], [true, false, 'hosted', null]);
    assert.match(on.invite, /^[0-9a-f]{16}$/);
    assert.doesNotMatch(JSON.stringify(on), /usage-code/);
    const off = await make({ usage: false });
    assert.deepEqual([off.enabled, off.notice], [false, false]);
    const unasked = await make({});
    assert.deepEqual([unasked.enabled, unasked.notice], [true, true], 'the inbox page tells a person the landing page did not');
  });

  it('serves the page under the inbox address, and nothing at an address nobody created', async () => {
    const bare = await fetch(inbox, { redirect: 'manual' });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), `${inbox}/`);
    const page = await fetch(`${inbox}/`, { redirect: 'manual' });
    assert.equal(page.status, 200, 'the page comes back itself, with no redirect');
    assert.match(await page.text(), /<title>Your Attention<\/title>/);
    assert.equal((await fetch(`${inbox}/vendor/openui-bundle.min.js`)).status, 200);
    assert.equal((await fetch(`${base}/i/${'0'.repeat(32)}/v1/info`)).status, 404);
    assert.equal((await fetch(`${inbox}/v1/state`)).status, 401);
    assert.equal((await fetch(`${inbox}/v1/state`, { headers: { authorization: `Bearer ${owner}` } })).status, 200);
  });

  it('pairs an agent through a system card', async () => {
    const { id } = (await (await fetch(`${inbox}/v1/pair`, { method: 'POST', body: JSON.stringify({ name: 'ci agent' }) })).json()) as { id: string };
    await fetch(`${inbox}/v1/cards/pair-${id}/answer`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ values: { choice: 'approve' } }) });
    agent = ((await (await fetch(`${inbox}/v1/pair/${id}`)).json()) as { token: string }).token;
    assert.ok(agent);
  });

  it('serves events over WebSockets only, so idle inboxes can sleep', async () => {
    for (const path of ['/v1/events', '/v1/stream?agent=x', '/v1/poll?agent=x']) {
      assert.equal((await fetch(`${inbox}${path}`, { headers: { authorization: `Bearer ${owner}` } })).status, 410, path);
    }
  });

  it('scopes the sign-in cookie to the inbox address', async () => {
    const res = await fetch(`${inbox}/v1/login`, { method: 'POST', body: JSON.stringify({ token: owner }) });
    assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`Path=${new URL(inbox).pathname}/`));
  });

  it('carries page events to the owner page over a WebSocket', async () => {
    const page = new WebSocket(`${inbox.replace(/^http/, 'ws')}/v1/ws?page=1&viewer=test-page`, { headers: { authorization: `Bearer ${owner}` } });
    const got: string[] = [];
    page.on('message', (d) => got.push(String(d)));
    await new Promise((r, j) => { page.once('open', r); page.once('error', j); });
    page.send('{"type":"ping"}');
    await fetch(`${inbox}/v1/cards`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ id: 'cf-page', agent: 'cf', title: 'On the page?' }) });
    await until(async () => (got.some((t) => JSON.parse(t).type === 'change') && got.some((t) => JSON.parse(t).type === 'pong')) || undefined);
    page.close();
  });

  for (const transport of ['ws'] as const) {
    it(`delivers an answer over ${transport}, through the Worker to the Durable Object`, async () => {
      const client = new Client({ url: inbox, token: agent });
      await client.post({ id: `cf-${transport}`, agent: `cf-${transport}`, title: `Over ${transport} on workerd?` });
      const got: AgentEvent[] = [];
      const stop = new AbortController();
      void client.stream(`cf-${transport}`, (e) => { got.push(e); }, stop.signal, transport);
      await until(async () => {
        const s = (await (await fetch(`${inbox}/v1/state`, { headers: { authorization: `Bearer ${owner}` } })).json()) as { presence: Record<string, { online: boolean }> };
        return s.presence[`cf-${transport}`]?.online || undefined;
      });
      await fetch(`${inbox}/v1/cards/cf-${transport}/answer`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ comment: transport }) });
      const ev = await until(async () => got.find((e) => e.type === 'answer'));
      assert.equal(ev.type === 'answer' && ev.answer.comment, transport);
      stop.abort();
    });
  }

  it('keeps attachment bytes in R2 and serves them back', async () => {
    const client = new Client({ url: inbox, token: agent });
    const card = await client.post({ id: 'cf-file', agent: 'cf', title: 'Read this', attachments: [{ src: `data:text/markdown;base64,${Buffer.from('# From R2').toString('base64')}`, name: 'r2.md' }] });
    const res = await fetch(`${inbox}/v1/attachments/${card.attachments?.[0]?.id}`, { headers: { authorization: `Bearer ${agent}` } });
    assert.equal(await res.text(), '# From R2');
  });

  it('searches past answers in the Durable Object storage', async () => {
    const hits = await new Client({ url: inbox, token: agent }).search('workerd');
    assert.ok(hits.some((h) => h.card.id === 'cf-ws'));
  });

  it('refuses files past the inbox lifetime limit', async () => {
    const client = new Client({ url: inbox, token: agent });
    const src = `data:application/octet-stream;base64,${Buffer.alloc(3000, 1).toString('base64')}`;
    await client.post({ id: 'cf-big-1', agent: 'cf', title: 'One', attachments: [{ src, name: 'a.bin' }] });
    await assert.rejects(client.post({ id: 'cf-big-2', agent: 'cf', title: 'Two', attachments: [{ src, name: 'b.bin' }] }), /lifetime limit of 150000/);
  });

  // Last, because they use up the minute's requests.
  it('limits signed-in calls per inbox, and strangers cannot use up the owner\'s budget', async () => {
    const seed = spawnSync(WRANGLER, ['kv', 'key', 'put', 'invite:second-code-0123456789', '1', '--binding', 'INVITES', '--local', '--persist-to', persist], { cwd: ROOT, env, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.equal(seed.status, 0, seed.stderr);
    const made = (await (await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'second-code-0123456789' }) })).json()) as { url: string; login: string };
    const other = made.url.replace(/\/$/, '');
    const otherOwner = decodeURIComponent(made.login.split('#token=')[1] ?? '');
    // workerd drops connections past a few hundred at once, so each burst goes in batches.
    const burst = async (url: string, headers: Record<string, string>): Promise<number[]> => {
      const all: number[] = [];
      for (let i = 0; i < 1250 && !all.includes(429); i += 125) {
        all.push(...await Promise.all(Array.from({ length: 125 }, () => fetch(url, { headers }).then((r) => r.status))));
      }
      return all;
    };
    assert.ok((await burst(`${inbox}/v1/cards`, { authorization: `Bearer ${agent}` })).includes(429), 'signed-in calls past 300 a minute');
    assert.equal((await fetch(`${other}/v1/state`, { headers: { authorization: `Bearer ${otherOwner}` } })).status, 200, 'another inbox has its own count');
    assert.ok((await burst(`${other}/v1/info`, {})).includes(429), 'calls without a token past 100 a minute');
    assert.equal((await fetch(`${other}/v1/state`, { headers: { authorization: `Bearer ${otherOwner}` } })).status, 200, 'the owner still gets in');
  });

});
