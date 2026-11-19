// `your-attention open --link` prints a one-time sign-in link, for a browser the command cannot open, such as a private window.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, stopAndRemove, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];

describe('your-attention open --link', () => {
  it('prints a link that signs in once, and never the owner token', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-open-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention') };
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    try {
      const info = await until(() => (fs.existsSync(path.join(env.YOUR_ATTENTION_HOME, 'server.json')) ? JSON.parse(fs.readFileSync(path.join(env.YOUR_ATTENTION_HOME, 'server.json'), 'utf8')) as { url: string } : undefined));
      const owner = fs.readFileSync(path.join(env.YOUR_ATTENTION_HOME, 'owner-token'), 'utf8').trim();
      const run = spawnSync(process.execPath, [...CLI, 'open', '--link'], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.includes(owner), false);
      const link = /(http\S+#signin=(\S+))/.exec(run.stdout);
      assert.ok(link, run.stdout);
      assert.equal(link[1]!.startsWith(info.url), true);
      assert.match(run.stdout, /once, within 5 minutes/);
      const login = () => fetch(`${info.url}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: decodeURIComponent(link[2]!) }) });
      // The same sign-in as a code to type, for a sign-in page with no address bar. Using the link ends it too.
      const typed = /type this code on the sign-in page: ([2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4})$/m.exec(run.stdout);
      assert.ok(typed, run.stdout);
      assert.equal((await login()).ok, true);
      assert.equal((await login()).ok, false);
      const byCode = await fetch(`${info.url}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: typed[1] }) });
      assert.equal(byCode.status, 401);
      // A fresh code, typed as printed with its dash, signs in, so the 401 above comes from the used link.
      const again = spawnSync(process.execPath, [...CLI, 'open', '--link'], { env, encoding: 'utf8' });
      const fresh = /type this code on the sign-in page: (\S+)$/m.exec(again.stdout);
      assert.ok(fresh, again.stdout);
      const typedFresh = await fetch(`${info.url}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: fresh[1] }) });
      assert.equal(typedFresh.status, 200);
      serve.kill();
      await until(async () => (await fetch(`${info.url}/v1/info`).then(() => false, () => true)) || undefined);
      const down = spawnSync(process.execPath, [...CLI, 'open', '--link'], { env, encoding: 'utf8' });
      assert.notEqual(down.status, 0);
      assert.match(down.stderr, /No inbox runs on this machine/);
    } finally {
      await stopAndRemove(serve, home);
    }
  });
});
