// `your-attention ack <card>` marks an answer read for an agent that took it out of band, as a script reading `watch` does.
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

describe('marking an answer read from the command line', () => {
  it('sets readAt on the answer, and refuses a card nobody answered', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-ack-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention') };
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    try {
      const file = path.join(env.YOUR_ATTENTION_HOME, 'server.json');
      const { url } = await until(() => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string } : undefined));
      const read = (f: string) => fs.readFileSync(path.join(env.YOUR_ATTENTION_HOME, f), 'utf8').trim();
      const call = (token: string, method: string, route: string, body?: unknown) => fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const agent = read('agent-token');
      const owner = read('owner-token');
      await call(agent, 'POST', '/v1/cards', { id: 'answered-card', agent: 'a', title: 'Answered' });
      await call(agent, 'POST', '/v1/cards', { id: 'open-card', agent: 'a', title: 'Waiting' });
      await call(owner, 'POST', '/v1/cards/answered-card/answer', { values: {} });
      const acked = await run(env, 'ack', 'answered-card');
      assert.equal(acked.code, 0, acked.stderr);
      assert.match(acked.stdout, /Card answered-card is read\./);
      const answer = (await (await call(owner, 'GET', '/v1/cards/answered-card')).json()) as { answer: { readAt: number | null; deliveredAt: number | null } };
      assert.notEqual(answer.answer.readAt, null, 'the answer is read');
      assert.notEqual(answer.answer.deliveredAt, null, 'a card acked without a stream is delivered in the same step');
      const missing = await run(env, 'ack', 'open-card');
      assert.notEqual(missing.code, 0, 'a card nobody answered is refused');
      assert.match(missing.stderr, /no answer for this card/);
      const usage = await run(env, 'ack');
      assert.notEqual(usage.code, 0);
      assert.match(usage.stderr, /Usage: your-attention ack <card>/);
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
