// `your-attention stop` ends the inbox that `your-attention serve` started on this machine.
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
