// `your-attention start` runs the inbox in the background, and `your-attention stop` ends it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];

function sandbox() {
  // HOME moves too, so the test never finds or stops a real launchd or systemd service.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-stop-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention') };
  return { home, env, inbox: env.YOUR_ATTENTION_HOME };
}

describe('your-attention stop', () => {
  it('stops the running inbox, which exits cleanly and forgets its address', async () => {
    const { home, env, inbox } = sandbox();
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    const exited = new Promise<number | null>((r) => serve.once('exit', (code) => r(code)));
    try {
      const info = await until(() => (fs.existsSync(path.join(inbox, 'server.json')) ? JSON.parse(fs.readFileSync(path.join(inbox, 'server.json'), 'utf8')) as { url: string } : undefined));
      const agent = fs.readFileSync(path.join(inbox, 'agent-token'), 'utf8').trim();
      assert.equal((await fetch(`${info.url}/v1/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${agent}` } })).status, 403);
      const stop = spawnSync(process.execPath, [...CLI, 'stop'], { env, encoding: 'utf8' });
      assert.equal(stop.status, 0, stop.stderr);
      assert.match(stop.stdout, /Stopped the inbox/);
      assert.equal(await exited, 0);
      assert.equal(fs.existsSync(path.join(inbox, 'server.json')), false);
      await assert.rejects(fetch(`${info.url}/v1/info`));
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('starts the inbox in the background and returns to the shell, once', async () => {
    const { home, env, inbox } = sandbox();
    try {
      const start = spawnSync(process.execPath, [...CLI, 'start', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, encoding: 'utf8', timeout: 20_000 });
      assert.equal(start.status, 0, start.stderr);
      const { url } = JSON.parse(fs.readFileSync(path.join(inbox, 'server.json'), 'utf8')) as { url: string };
      assert.match(start.stdout, new RegExp(`Started the inbox on ${url}`));
      assert.equal(((await (await fetch(`${url}/v1/info`)).json()) as { name: string }).name, 'your-attention');
      const again = spawnSync(process.execPath, [...CLI, 'start', '--no-mdns'], { env, encoding: 'utf8', timeout: 20_000 });
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, new RegExp(`already runs on ${url}`));
      assert.equal(spawnSync(process.execPath, [...CLI, 'stop'], { env, encoding: 'utf8' }).status, 0);
      await assert.rejects(fetch(`${url}/v1/info`));
    } finally {
      spawnSync(process.execPath, [...CLI, 'stop'], { env });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('shows why the inbox did not start', () => {
    const { home, env } = sandbox();
    try {
      const start = spawnSync(process.execPath, [...CLI, 'start', '--relay', 'ws://127.0.0.1:9/', '--relay-key-env', 'YA_NO_SUCH_KEY'], { env, encoding: 'utf8', timeout: 20_000 });
      assert.equal(start.status, 1);
      assert.match(start.stderr, /--relay needs the relay key/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so when no inbox runs', () => {
    const { home, env } = sandbox();
    try {
      const stop = spawnSync(process.execPath, [...CLI, 'stop'], { env, encoding: 'utf8' });
      assert.equal(stop.status, 1);
      assert.match(stop.stderr, /No inbox runs on this machine/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('your-attention start next to another server', () => {
  it('starts the inbox when its old address now belongs to a server that is not an inbox', async () => {
    const { home, env, inbox } = sandbox();
    const http = await import('node:http');
    const other = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html></html>'); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const port = (other.address() as { port: number }).port;
    try {
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, 'server.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: 1 }));
      const start = spawnSync(process.execPath, [...CLI, 'start', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, encoding: 'utf8', timeout: 20_000 });
      assert.equal(start.status, 0, start.stderr);
      assert.match(start.stdout, /Started the inbox/);
    } finally {
      spawnSync(process.execPath, [...CLI, 'stop'], { env });
      other.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
