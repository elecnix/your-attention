// `your-attention ack <card>` marks an answer read for an agent that took it out of band, as a script reading `watch` does.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { callAt, ROOT, until } from './harness.ts';

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
      const call = (token: string, method: string, route: string, body?: unknown) => callAt(url, token, method, route, body);
      const agent = read('agent-token');
      const owner = read('owner-token');
      await call(agent, 'POST', '/v1/cards', { id: 'answered-card', agent: 'a', title: 'Answered' });
      await call(agent, 'POST', '/v1/cards', { id: 'open-card', agent: 'a', title: 'Waiting' });
      await call(owner, 'POST', '/v1/cards/answered-card/answer', { values: {} });
      const acked = await run(env, 'ack', 'answered-card');
      assert.equal(acked.code, 0, acked.stderr);
      assert.match(acked.stdout, /Card answered-card is read\./);
      const answer = (await (await call(owner, 'GET', '/v1/cards/answered-card')).json()) as { answer: { readAt?: number | null; deliveredAt?: number | null } };
      assert.equal(typeof answer.answer.readAt, 'number', 'the answer is read');
      assert.equal(typeof answer.answer.deliveredAt, 'number', 'a card acked without a stream is delivered in the same step');
      const missing = await run(env, 'ack', 'open-card');
      assert.notEqual(missing.code, 0, 'a card nobody answered is refused');
      assert.match(missing.stderr, /no answer for this card/);
      await call(agent, 'POST', '/v1/cards', { id: 'second-card', agent: 'a', title: 'Also answered' });
      await call(owner, 'POST', '/v1/cards/second-card/answer', { values: {} });
      const both = await run(env, 'ack', 'answered-card', 'second-card');
      assert.equal(both.code, 0, both.stderr);
      assert.match(both.stdout, /Card answered-card is read\.[\s\S]*Card second-card is read\./, 'every id given is acked');
      const usage = await run(env, 'ack');
      assert.notEqual(usage.code, 0);
      assert.match(usage.stderr, /Usage: your-attention ack <card>/);
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe('a watcher that leaves answers unread', () => {
  // Windows ends a child without running its signal handlers, so the notice cannot be exercised by SIGTERM there.
  it('names the ids to ack, even when --no-card keeps the card out of its output', { skip: process.platform === 'win32' && 'a signal ends the watcher before it can speak on Windows' }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-watch-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention') };
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    let watch: ReturnType<typeof spawn> | undefined;
    try {
      const file = path.join(env.YOUR_ATTENTION_HOME, 'server.json');
      const { url } = await until(() => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string } : undefined));
      const read = (f: string) => fs.readFileSync(path.join(env.YOUR_ATTENTION_HOME, f), 'utf8').trim();
      const call = (token: string, method: string, route: string, body?: unknown) => callAt(url, token, method, route, body);
      await call(read('agent-token'), 'POST', '/v1/cards', { id: 'left-unread', agent: 'a', title: 'Answer me' });
      // `--no-card` is the case the advice has to survive: the line carries no id, and the notice has to supply one.
      watch = spawn(process.execPath, [...CLI, 'watch', '--agent', 'a', '--no-card'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      watch.stdout?.on('data', (d: Buffer) => { out += String(d); });
      watch.stderr?.on('data', (d: Buffer) => { err += String(d); });
      await until(() => (out.includes('hello') ? true : undefined));
      await call(read('owner-token'), 'POST', '/v1/cards/left-unread/answer', { comment: 'here' });
      await until(() => (out.includes('"answer"') ? true : undefined));
      watch.kill('SIGTERM');
      await until(() => (err.includes('without acknowledging') ? true : undefined));
      assert.match(err, /Pass --ack next time: your-attention ack left-unread/);
      // The line carries no card object, so the id in the answer payload is the only hint it gives; the notice names it.
      const answerLine = out.split('\n').find((l) => l.includes('"answer"'));
      assert.ok(answerLine, 'the watcher printed the answer');
      assert.equal('card' in (JSON.parse(answerLine) as object), false, 'the line leaves the card object out');
    } finally {
      watch?.kill('SIGKILL');
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
