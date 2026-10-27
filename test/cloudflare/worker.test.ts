// The Cloudflare build as it would run when deployed: `wrangler dev` runs the Worker,
// the Durable Objects, R2 and KV locally in workerd, in hosted mode with invite codes.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
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
  const seed = spawnSync(WRANGLER, ['kv', 'key', 'put', 'invite:test-code', '2', '--binding', 'INVITES', '--local', '--persist-to', persist], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const port = await freePort();
  dev = spawn(WRANGLER, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--var', 'MODE:hosted', '--persist-to', persist, '--show-interactive-dev-session=false'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const res = await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'test-code' }) });
    assert.equal(res.status, 201);
    const { url, login } = (await res.json()) as { url: string; login: string };
    assert.match(url, /\/i\/[0-9a-f]{32}\/$/);
    inbox = url.replace(/\/$/, '');
    owner = decodeURIComponent(login.split('#token=')[1] ?? '');
    assert.equal((await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'test-code' }) })).status, 201);
    assert.equal((await fetch(`${base}/new`, { method: 'POST', body: JSON.stringify({ invite: 'test-code' }) })).status, 403, 'the code had two uses');
  });

  it('serves the page under the inbox address, and nothing at an address nobody created', async () => {
    assert.match(await (await fetch(`${inbox}/`)).text(), /<title>Your Attention<\/title>/);
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

  for (const transport of ['sse', 'ws', 'poll'] as const) {
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
    assert.ok(hits.some((h) => h.card.id === 'cf-sse'));
  });
});
