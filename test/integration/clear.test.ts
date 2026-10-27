// `your-attention clear` clears the cards you dealt with, and `your-attention reset --yes` empties the inbox.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ROOT, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];
const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  promisify(execFile)(process.execPath, [...CLI, ...args], { env, encoding: 'utf8' }).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);

describe('clearing the inbox from the command line', () => {
  it('clears answered cards, keeps waiting ones, and resets only with --yes', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-clear-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention') };
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    try {
      const file = path.join(env.YOUR_ATTENTION_HOME, 'server.json');
      const { url } = await until(() => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string } : undefined));
      const read = (f: string) => fs.readFileSync(path.join(env.YOUR_ATTENTION_HOME, f), 'utf8').trim();
      const call = (token: string, method: string, route: string, body?: unknown) => fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const agent = read('agent-token');
      const owner = read('owner-token');
      await call(agent, 'POST', '/v1/cards', { id: 'done', agent: 'a', title: 'Answered' });
      await call(agent, 'POST', '/v1/cards', { id: 'waits', agent: 'a', title: 'Waiting' });
      await call(owner, 'POST', '/v1/cards/done/answer', { values: {} });
      assert.equal((await call(agent, 'POST', '/v1/archive')).status, 403);
      const clear = await run(env, 'clear');
      assert.equal(clear.code, 0, clear.stderr);
      assert.match(clear.stdout, /Cleared 1 cards/);
      const ids = async () => ((await (await call(owner, 'GET', '/v1/state')).json()) as { cards: { id: string }[] }).cards.map((c) => c.id);
      assert.deepEqual(await ids(), ['waits']);
      assert.equal((await call(owner, 'POST', '/v1/reset', {})).status, 400);
      const refused = await run(env, 'reset');
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /--yes/);
      assert.deepEqual(await ids(), ['waits']);
      const reset = await run(env, 'reset', '--yes');
      assert.equal(reset.code, 0, reset.stderr);
      assert.match(reset.stdout, /Removed 2 cards/);
      assert.deepEqual(await ids(), []);
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
