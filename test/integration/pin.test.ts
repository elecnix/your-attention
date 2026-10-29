// `your-attention pin` sets, resets and removes the PIN of the inbox this machine runs, with the owner-token file.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pinKey } from '../../src/core/pin.ts';
import { ROOT, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];

describe('your-attention pin', () => {
  it('sets, resets and clears the PIN, through a lockout, and a service start never asks', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-pin-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention') };
    // No terminal, as under launchd or systemd: the inbox starts without a question.
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    const cli = (args: string[], input = '') => spawnSync(process.execPath, [...CLI, ...args], { env, encoding: 'utf8', input });
    try {
      const info = await until(() => (fs.existsSync(path.join(env.YOUR_ATTENTION_HOME, 'server.json')) ? JSON.parse(fs.readFileSync(path.join(env.YOUR_ATTENTION_HOME, 'server.json'), 'utf8')) as { url: string } : undefined));
      assert.match(cli(['pin', 'status']).stdout, /has no PIN/);
      const set = cli(['pin', 'set'], '2468\n2468\n');
      assert.equal(set.status, 0, set.stderr);
      assert.equal(`${set.stdout}${set.stderr}`.includes('2468'), false, 'the PIN is never printed');
      assert.match(cli(['pin', 'status']).stdout, /has a PIN/);
      assert.notEqual(cli(['pin', 'set'], '1357\n1357\n').status, 0, 'set does not replace a PIN');

      // A browser signs in with a one-time link, and the page needs the PIN.
      const link = cli(['login-url']).stdout.trim();
      const owner = fs.readFileSync(path.join(env.YOUR_ATTENTION_HOME, 'owner-token'), 'utf8').trim();
      assert.equal(link.includes(owner), false, 'login-url never prints the owner token');
      const code = decodeURIComponent(/#signin=(\S+)/.exec(link)?.[1] ?? '');
      const login = await fetch(`${info.url}/v1/login`, { method: 'POST', body: JSON.stringify({ code }) });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const page = (route: string, init: RequestInit = {}) => fetch(`${info.url}${route}`, { ...init, headers: { cookie, 'x-your-attention': '1', ...init.headers } });
      assert.equal((await page('/v1/state')).status, 423);
      // The page derives each key with the salt and iterations the inbox hands out, as web/pin.js does.
      const key = async (pin: string) => { const s = (await (await page('/v1/pin')).json()) as { salt: string; iterations: number }; return pinKey(pin, s.salt, s.iterations); };
      for (let i = 0; i < 5; i++) await page('/v1/unlock', { method: 'POST', body: JSON.stringify({ key: await key('0000') }) });
      assert.equal((await page('/v1/unlock', { method: 'POST', body: JSON.stringify({ key: await key('2468') }) })).status, 429);
      assert.match(cli(['pin', 'status']).stdout, /locked the page until/);

      // A forgotten PIN, during a lockout: the owner-token file resets it.
      const reset = cli(['pin', 'reset'], '1357\n1357\n');
      assert.equal(reset.status, 0, reset.stderr);
      const unlocked = await page('/v1/unlock', { method: 'POST', body: JSON.stringify({ key: await key('1357') }) });
      assert.equal(unlocked.status, 200);
      const { unlock } = (await unlocked.json()) as { unlock: string };
      assert.equal((await page('/v1/state', { headers: { 'x-your-attention-unlock': unlock } })).status, 200);

      assert.equal(cli(['pin', 'clear']).status, 0);
      assert.equal((await page('/v1/state')).status, 200);
      assert.match(cli(['pin', 'status']).stdout, /has no PIN/);
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
