// `your-attention status` reports the inbox this machine runs, its files, and its pairings.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, start } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];

interface Run { code: number; out: string; err: string }

/** Run `status` with `home` as the machine's inbox home, and a home of its own so it finds no real service.
 * The inbox it reports may run in this process, so it runs without blocking the test's event loop. */
function status(home: string, extra: Record<string, string> = {}): Promise<Run> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-status-user-'));
  // The two variables win over the files, so a test names them itself or leaves them out.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, YOUR_ATTENTION_HOME: home };
  delete env['YOUR_ATTENTION_URL'];
  delete env['YOUR_ATTENTION_TOKEN'];
  Object.assign(env, extra);
  return new Promise<Run>((resolve) => {
    execFile(process.execPath, [...CLI, 'status'], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
      fs.rmSync(sandbox, { recursive: true, force: true });
      resolve({ code: error ? 1 : 0, out: stdout, err: stderr });
    });
  });
}

/** A test of a machine home that holds nothing but what the test writes, removed after it. */
function withHome(run: (home: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-status-'));
    try { await run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };
}

/** The report of such a home, which every case expects to exit 0. */
async function reportFor(home: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await status(home, extra);
  assert.equal(r.code, 0, r.err);
  return r.out;
}

describe('your-attention status', () => {
  it('reports the running inbox, its files and its settings, and prints no token', async () => {
    const h = await start();
    try {
      const r = await status(h.home);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /state\s+running/);
      assert.ok(r.out.includes(h.server.url), r.out);
      assert.match(r.out, /pid\s+\d+/);
      assert.match(r.out, /inbox id\s+\S+/);
      assert.match(r.out, /protocol\s+1/);
      assert.match(r.out, /PIN\s+none/);
      assert.match(r.out, /usage counts\s+off: this machine sends none \(a test inbox sends nothing\)/);
      assert.ok(r.out.includes(h.home), r.out);
      assert.match(r.out, /database\s+\S+inbox\.sqlite, [\d.]+ (bytes|KB|MB)/);
      assert.match(r.out, /tokens\s+owner-token, agent-token, extension-token/);
      // The report names the files, and never their contents.
      for (const f of ['owner-token', 'agent-token', 'extension-token']) {
        assert.ok(!r.out.includes(fs.readFileSync(path.join(h.home, f), 'utf8').trim()), `${f} leaked into the output`);
      }
    } finally {
      await h.stop();
    }
  });

  it('says no inbox runs on a machine that has none, and which command starts one', withHome(async (home) => {
    const out = await reportFor(home);
    assert.match(out, /state\s+none on this machine/);
    assert.match(out, /start it\s+your-attention start/);
    assert.match(out, /tokens\s+none yet/);
    assert.match(out, /Paired inboxes\n\s+none\s+pair with/);
  }));

  it('lists a pairing and whether that inbox answers', async () => {
    const h = await start();
    try {
      await withHome(async (machine) => {
        fs.writeFileSync(path.join(machine, 'client.json'), JSON.stringify({ url: h.server.url, token: h.agentToken }));
        const out = await reportFor(machine);
        assert.ok(out.includes(`${h.server.url} (client.json, answering)`), out);
        // A machine that runs no inbox still shows where its agents send their cards.
        assert.match(out, /state\s+none on this machine/);
      })();
    } finally {
      await h.stop();
    }
  });

  it('says a pairing that does not answer does not answer', withHome(async (home) => {
    fs.writeFileSync(path.join(home, 'client.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 't' }));
    assert.ok((await reportFor(home)).includes('http://127.0.0.1:1 (client.json, not answering)'));
  }));

  it('calls an address file left by a crashed inbox what it is', withHome(async (home) => {
    fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1', port: 1, pid: 1 }));
    const out = await reportFor(home);
    assert.match(out, /state\s+not running; \S+server\.json is left from an earlier run/);
    assert.match(out, /start it\s+your-attention start/);
  }));

  it('says when the environment sends agents somewhere other than the files', withHome(async (home) => {
    const out = await reportFor(home, { YOUR_ATTENTION_URL: 'https://inbox.example' });
    assert.match(out, /agents use\s+YOUR_ATTENTION_URL is set alone, so agents ignore it/);
    assert.ok(!out.includes('YOUR_ATTENTION_URL, with'), out);
  }));

  it('prints the names of the environment variables, and never the token', withHome(async (home) => {
    const secret = 'ya-token-value-4c1f';
    const out = await reportFor(home, { YOUR_ATTENTION_URL: 'https://inbox.example', YOUR_ATTENTION_TOKEN: secret });
    assert.match(out, /agents use\s+https:\/\/inbox\.example, with YOUR_ATTENTION_TOKEN, before the files above/);
    assert.ok(!out.includes(secret), 'the environment token leaked into the output');
  }));

  it('does not call another program on the inbox address a running inbox', withHome(async (home) => {
    // A crashed inbox can leave its address in server.json while something else takes the port.
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'some-other-program', id: 'not-an-inbox' }));
    });
    await new Promise<void>((listening) => other.listen(0, '127.0.0.1', listening));
    try {
      const { port } = other.address() as AddressInfo;
      fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: 1 }));
      const out = await reportFor(home);
      assert.match(out, /state\s+not running/);
      assert.match(out, /start it\s+your-attention start/);
    } finally {
      await new Promise<void>((closed) => other.close(() => closed()));
    }
  }));
});
