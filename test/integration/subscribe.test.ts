// `your-attention subscribe` sends an agent's answers to a webhook once the owner approves, and `status` lists it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AnswerEvent } from '../../src/core/types.ts';
import { ROOT, start, until } from './harness.ts';

interface Run { code: number; out: string; err: string }

/** Run the CLI as an agent of the inbox, with its home as the machine's inbox home. It runs without blocking the inbox in this process. */
function cli(home: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-subscribe-user-'));
  const vars: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, YOUR_ATTENTION_HOME: home, ...env };
  return new Promise<Run>((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), ...args], { env: vars, encoding: 'utf8' }, (error, stdout, stderr) => {
      fs.rmSync(sandbox, { recursive: true, force: true });
      resolve({ code: error ? 1 : 0, out: stdout, err: stderr });
    });
  });
}

describe('your-attention subscribe', () => {
  it('asks the owner, sends each answer once approved, shows in status, and stops on unsubscribe', async () => {
    // The inbox calls https only, so the test takes the calls in place of the network.
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const h = await start({ fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status: 204 });
    }) as typeof fetch });
    try {
      const agent = { YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken };
      const sub = await cli(h.home, ['subscribe', '--agent', 'cli:deploy', '--webhook', 'https://hooks.example.com/abc', '--header', 'Authorization: Bearer hook-secret'], agent);
      assert.equal(sub.code, 0, sub.err);
      const made = JSON.parse(sub.out) as { id: string; status: string; card: string; secret: string };
      assert.equal(made.status, 'pending');
      assert.match(sub.err, /approve the card/);

      const waiting = await cli(h.home, ['status']);
      assert.match(waiting.out, /Answer webhooks\n\s+cli:deploy\s+hooks\.example\.com \(waiting for your approval on its card; headers Authorization\)/);
      assert.ok(!waiting.out.includes('hook-secret') && !waiting.out.includes(made.secret), waiting.out);

      assert.equal((await h.owner('POST', `/v1/cards/${made.card}/answer`, { values: { choice: 'approve' } })).status, 200);
      const post = await fetch(`${h.server.url}/v1/cards`, { method: 'POST', headers: { authorization: `Bearer ${h.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ship', agent: 'cli:deploy', title: 'Ship to prod?' }) });
      assert.equal(post.status, 201);
      await h.owner('POST', '/v1/cards/ship/answer', { values: { choice: 'yes' } });
      const call = await until(() => calls[0]);
      assert.equal(call.url, 'https://hooks.example.com/abc');
      assert.equal(call.headers.get('authorization'), 'Bearer hook-secret');
      const ev = JSON.parse(call.body) as AnswerEvent;
      assert.equal(ev.card.id, 'ship');
      assert.equal(ev.answer.values['choice'], 'yes');
      await until(async () => (await h.stored()).states['ship'] === 'read');
      assert.match((await cli(h.home, ['status'])).out, /cli:deploy\s+hooks\.example\.com \(approved, 1 sent; headers Authorization\)/);

      const off = await cli(h.home, ['unsubscribe', '--agent', 'cli:deploy'], agent);
      assert.equal(off.code, 0, off.err);
      assert.match(off.out, /Stopped sending the answers for cli:deploy/);
      assert.match((await cli(h.home, ['status'])).out, /Answer webhooks\n\s+none\s+add one with/);
    } finally {
      await h.stop();
    }
  });

  it('reads secret headers from a file or stdin, so they stay out of argv', async () => {
    const h = await start();
    try {
      const agent = { YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken };
      const file = path.join(h.home, 'hook-headers');
      fs.writeFileSync(file, 'Authorization: Bearer from-a-file\n\nX-Team: deploy\n');
      const urlFile = path.join(h.home, 'hook-url');
      fs.writeFileSync(urlFile, 'https://hooks.example.com/abc/secret-path\n');
      const r = await cli(h.home, ['subscribe', '--agent', 'from-file', '--webhook-file', urlFile, '--header-file', file], agent);
      assert.equal(r.code, 0, r.err);
      const piped = await new Promise<Run>((resolve) => {
        const child = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'subscribe', '--agent', 'from-stdin', '--webhook', 'https://hooks.example.com/abc', '--header-file', '-'],
          { env: { ...process.env, YOUR_ATTENTION_HOME: h.home, ...agent }, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, out: stdout, err: stderr }));
        child.stdin?.end('Authorization: Bearer from-stdin\n');
      });
      assert.equal(piped.code, 0, piped.err);
      const subs = h.server.inbox.listSubscriptions({ token: '', role: 'owner' });
      assert.deepEqual(subs.map((s) => [s.agent, s.headers]).sort(), [['from-file', ['Authorization', 'X-Team']], ['from-stdin', ['Authorization']]]);
      assert.equal(subs.find((s) => s.agent === 'from-file')?.url, 'https://hooks.example.com/abc/secret-path');
    } finally {
      await h.stop();
    }
  });

  it('reports a pairing whose inbox answers the webhook list with rows it cannot read', async () => {
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ agent: 'x' }, { agent: 'y', url: 'not a url', headers: 'none' }]));
    });
    await new Promise<void>((listening) => other.listen(0, '127.0.0.1', listening));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-subscribe-'));
    try {
      const { port } = other.address() as AddressInfo;
      fs.writeFileSync(path.join(home, 'client.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 't' }));
      const r = await cli(home, ['status']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Answer webhooks\n\s+x\s+an entry this report cannot read/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      await new Promise<void>((closed) => other.close(() => closed()));
    }
  });

  it('refuses an http webhook and a header without a name', async () => {
    const h = await start();
    try {
      const agent = { YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken };
      const plain = await cli(h.home, ['subscribe', '--agent', 'a', '--webhook', 'http://hooks.example.com/abc'], agent);
      assert.equal(plain.code, 1);
      assert.match(plain.err, /https/);
      const bad = await cli(h.home, ['subscribe', '--agent', 'a', '--webhook', 'https://hooks.example.com/abc', '--header', 'Bearer sk-not-a-name'], agent);
      assert.equal(bad.code, 1);
      assert.match(bad.err, /NAME: VALUE/);
      assert.ok(!bad.err.includes('sk-not-a-name'), 'the value of a malformed header stays out of the error');
      const blank = await cli(h.home, ['subscribe', '--agent', 'a', '--webhook', 'https://hooks.example.com/abc', '--header', ' : sk-blank-name'], agent);
      assert.equal(blank.code, 1);
      assert.match(blank.err, /has no name/);
      assert.ok(!blank.err.includes('sk-blank-name'));
      const missing = await cli(h.home, ['subscribe', '--agent', 'a', '--webhook', 'https://hooks.example.com/abc', '--header-file', path.join(h.home, 'no-such-file')], agent);
      assert.equal(missing.code, 1);
      assert.match(missing.err, /Could not read the headers in \S+no-such-file/);
      assert.doesNotMatch(missing.err, /at \S+\.ts:\d+/, 'no stack trace');
    } finally {
      await h.stop();
    }
  });
});
