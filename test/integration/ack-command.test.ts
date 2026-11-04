// `your-attention ack <card>` marks an answer read for an agent that took it out of band, as a script reading `watch` does.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { CLI_ARGS, ROOT, serveForTest, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'cli.ts')];
const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  promisify(execFile)(process.execPath, [...CLI, ...args], { env, encoding: 'utf8' }).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);

describe('marking an answer read from the command line', () => {
  it('sets readAt on every card it is given, and refuses one nobody answered', async () => {
    const server = await serveForTest('ya-ack-');
    try {
      const agent = server.read('agent-token');
      const owner = server.read('owner-token');
      await server.call(agent, 'POST', '/v1/cards', { id: 'answered-card', agent: 'a', title: 'Answered' });
      await server.call(agent, 'POST', '/v1/cards', { id: 'second-card', agent: 'a', title: 'Also answered' });
      await server.call(agent, 'POST', '/v1/cards', { id: 'open-card', agent: 'a', title: 'Waiting' });
      await server.call(owner, 'POST', '/v1/cards/answered-card/answer', { values: {} });
      await server.call(owner, 'POST', '/v1/cards/second-card/answer', { values: {} });

      const one = await run(server.env, 'ack', 'answered-card');
      assert.equal(one.code, 0, one.stderr);
      assert.match(one.stdout, /Card answered-card is read\./);
      const answer = (await (await server.call(owner, 'GET', '/v1/cards/answered-card')).json()) as { answer: { readAt?: number | null; deliveredAt?: number | null } };
      assert.equal(typeof answer.answer.readAt, 'number', 'the answer is read');
      assert.equal(typeof answer.answer.deliveredAt, 'number', 'a card acked without a stream is delivered in the same step');

      // The watcher's notice names several cards on one line, so the command has to take them all.
      const both = await run(server.env, 'ack', 'answered-card', 'second-card');
      assert.equal(both.code, 0, both.stderr);
      assert.match(both.stdout, /Card answered-card is read\.[\s\S]*Card second-card is read\./, 'every id given is acked');

      const missing = await run(server.env, 'ack', 'open-card');
      assert.notEqual(missing.code, 0, 'a card nobody answered is refused');
      assert.match(missing.stderr, /no answer for this card/);
      const usage = await run(server.env, 'ack');
      assert.notEqual(usage.code, 0);
      assert.match(usage.stderr, /Usage: your-attention ack <card>/);
    } finally {
      server.close();
    }
  });
});

describe('a watcher that leaves answers unread', () => {
  // Windows ends a child without running its signal handlers, so the notice cannot be exercised by SIGTERM there.
  it('names the ids to ack, even when --no-card keeps the card out of its output', { skip: process.platform === 'win32' && 'a signal ends the watcher before it can speak on Windows' }, async () => {
    const server = await serveForTest('ya-watch-');
    let watch: ReturnType<typeof spawn> | undefined;
    try {
      await server.call(server.read('agent-token'), 'POST', '/v1/cards', { id: 'left-unread', agent: 'a', title: 'Answer me' });
      // `--no-card` is the case the advice has to survive: the line carries no card, and the notice has to supply it.
      watch = spawn(process.execPath, [...CLI, 'watch', '--agent', 'a', '--no-card'], { env: server.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      watch.stdout?.on('data', (d: Buffer) => { out += String(d); });
      watch.stderr?.on('data', (d: Buffer) => { err += String(d); });
      await until(() => (out.includes('hello') ? true : undefined));
      await server.call(server.read('owner-token'), 'POST', '/v1/cards/left-unread/answer', { comment: 'here' });
      await until(() => (out.includes('"answer"') ? true : undefined));
      watch.kill('SIGTERM');
      await until(() => (err.includes('without acknowledging') ? true : undefined));
      assert.match(err, /Pass --ack next time: your-attention ack left-unread/);
      const answerLine = out.split('\n').find((l) => l.includes('"answer"'));
      assert.ok(answerLine, 'the watcher printed the answer');
      assert.equal('card' in (JSON.parse(answerLine) as object), false, 'the line leaves the card object out');
    } finally {
      watch?.kill('SIGKILL');
      server.close();
    }
  });
});

describe('finding what arrived while no watcher was running', () => {
  it('counts the answers this token has not acknowledged, and names the cards', async () => {
    const server = await serveForTest('ya-unread-');
    try {
      const agent = server.read('agent-token');
      const owner = server.read('owner-token');
      await server.call(agent, 'POST', '/v1/cards', { id: 'one', agent: 'cli:deploy', title: 'First' });
      await server.call(agent, 'POST', '/v1/cards', { id: 'two', agent: 'cli:deploy', title: 'Second' });
      await server.call(agent, 'POST', '/v1/cards', { id: 'elsewhere', agent: 'cli:other', title: 'Other agent' });
      const before = (await (await server.call(agent, 'GET', '/v1/unread?agent=cli:deploy')).json()) as { unread: number; cards: string[] };
      assert.deepEqual(before, { unread: 0, cards: [] }, 'a card nobody answered is not unread');

      for (const id of ['one', 'two', 'elsewhere']) await server.call(owner, 'POST', `/v1/cards/${id}/answer`, { values: {} });
      const after = (await (await server.call(agent, 'GET', '/v1/unread?agent=cli:deploy')).json()) as { unread: number; cards: string[] };
      assert.deepEqual(after, { unread: 2, cards: ['one', 'two'] }, 'the two answers for that agent');

      await server.call(agent, 'POST', '/v1/cards/one/ack', {});
      const left = (await (await server.call(agent, 'GET', '/v1/unread?agent=cli:deploy')).json()) as { unread: number; cards: string[] };
      assert.deepEqual(left, { unread: 1, cards: ['two'] }, 'an ack takes one out');
    } finally {
      server.close();
    }
  });
});
