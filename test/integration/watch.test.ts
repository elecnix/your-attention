// `your-attention watch` prints each answer for its agent as a line of JSON, and ends cleanly on a signal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { ROOT, start, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];

/** The whole lines a watcher has written. A chunk boundary can land inside a line, so the last part waits for its newline. */
function wholeLines(out: string): string[] {
  return out.split('\n').slice(0, -1).map((l) => l.trim()).filter(Boolean);
}

/** The first line of a card event. A watcher prints `hello` when its stream opens, and again after a reconnect. */
async function firstCardEvent(seen: { out: string }): Promise<Record<string, unknown>> {
  const line = await until(() => wholeLines(seen.out).find((l) => !l.includes('"type":"hello"')));
  return JSON.parse(line) as Record<string, unknown>;
}

/** Run `your-attention watch`, and collect what it writes. */
async function watching(home: string, ...args: string[]) {
  const child = spawn(process.execPath, [...CLI, 'watch', ...args], { env: { ...process.env, YOUR_ATTENTION_HOME: home } });
  const seen = { out: '', err: '' };
  child.stdout.on('data', (d) => { seen.out += String(d); });
  child.stderr.on('data', (d) => { seen.err += String(d); });
  // 'close' waits for stdio to drain, so a test that reads `seen` afterwards sees everything the child wrote; 'exit' fires
  // while a last chunk may still be on its way.
  const ended = new Promise<number | null>((resolve) => child.on('close', () => resolve(child.exitCode)));
  return { child, seen, ended, stop: async () => { child.kill('SIGTERM'); return ended; } };
}

describe('watching the inbox from the command line', () => {
  it('prints a line for each answer, and --ack marks it read', async () => {
    const h = await start();
    const w = await watching(h.home, '--agent', 'cli:watch', '--no-card', '--ack');
    try {
      await until(async () => (await h.stored()).presence['cli:watch']?.online);
      const posted = await new Client({ url: h.server.url, token: h.agentToken })
        .post({ id: 'watch-1', agent: 'cli:watch', title: 'Deploy now?', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }] });
      await h.owner('POST', `/v1/cards/${posted.id}/answer`, { values: { choice: 'o2' }, comment: 'after lunch' });
      const event = (await firstCardEvent(w.seen)) as unknown as { type: string; id: string; card?: unknown; answer: { values: unknown; comment: string }; receivedAt: number };
      assert.equal(event.type, 'answer');
      assert.ok(event.id.length > 0, 'the line carries the receipt');
      assert.equal('card' in event, false, '--no-card leaves the card out');
      assert.deepEqual(event.answer.values, { choice: 'o2' });
      assert.equal(event.answer.comment, 'after lunch');
      assert.equal(typeof event.receivedAt, 'number');
      assert.match(w.seen.err, /Watching .* for the answers to cards posted as cli:watch/);
      // Only a watcher that asked for it marks the answer read, so the agent's own session still sees it unread otherwise.
      await until(async () => (await h.stored()).states[posted.id] === 'read');
    } finally {
      const code = await w.stop();
      // The inbox stops before anything is asserted: a failed assertion must not strand the server this test started.
      await h.stop();
      // Windows has no SIGTERM to handle: a kill ends the process there, and the exit code is the killer's.
      if (process.platform !== 'win32') assert.equal(code, 0, 'a signal ends the watch cleanly');
    }
  });

  it('keeps the whole card by default, and only the named fields with --select', async () => {
    const h = await start();
    const whole = await watching(h.home, '--agent', 'cli:fields');
    const selected = await watching(h.home, '--agent', 'cli:select', '--select', 'id,title');
    try {
      // Each card is answered before its watcher may have connected, on purpose: the inbox sends an agent every answer it
      // stored and nobody received yet when that agent's stream opens, so the watcher prints it either way.
      const c = new Client({ url: h.server.url, token: h.agentToken });
      const a = await c.post({ id: 'watch-fields', agent: 'cli:fields', title: 'Ship the watcher?', text: 'It reads the agent stream.' });
      const b = await c.post({ id: 'watch-select', agent: 'cli:select', title: 'Ship the watcher?', text: 'It reads the agent stream.' });
      await h.owner('POST', `/v1/cards/${a.id}/answer`, { values: {} });
      await h.owner('POST', `/v1/cards/${b.id}/answer`, { values: {} });
      const one = (await firstCardEvent(whole.seen)) as { type: string; card?: Record<string, unknown> };
      assert.equal(one.type, 'answer');
      assert.deepEqual(Object.keys(one.card ?? {}).includes('createdAt'), true, 'the whole card comes with its stored fields');
      assert.equal(one.card?.['title'], 'Ship the watcher?');
      const two = (await firstCardEvent(selected.seen)) as { type: string; card?: Record<string, unknown> };
      assert.deepEqual(two.card, { id: 'watch-select', title: 'Ship the watcher?' });
    } finally {
      await whole.stop();
      await selected.stop();
      await h.stop();
    }
  });

  it('follows every card as the owner, narrowed by --agent and --type, without counting as a page', async () => {
    const h = await start();
    const mine = await watching(h.home, '--role', 'owner', '--agent', 'cli:mine', '--select', 'id,agent');
    const changes = await watching(h.home, '--role', 'owner', '--type', 'change', '--no-card');
    try {
      await until(() => wholeLines(mine.seen.out).some((l) => l.includes('"type":"hello"')));
      await until(() => /Watching .* as the owner, for every card/.test(changes.seen.err));
      const c = new Client({ url: h.server.url, token: h.agentToken });
      await c.post({ id: 'owner-other', agent: 'cli:other', title: 'Someone else\'s card' });
      await c.post({ id: 'owner-mine', agent: 'cli:mine', title: 'Merge it?' });
      await h.owner('POST', '/v1/cards/owner-mine/answer', { values: {} });
      const answered = await until(() => wholeLines(mine.seen.out).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['state'] === 'answered'));
      assert.equal(answered['type'], 'change');
      assert.equal(answered['id'], 'owner-mine');
      assert.deepEqual(answered['card'], { id: 'owner-mine', agent: 'cli:mine' });
      assert.equal(typeof answered['receivedAt'], 'number');
      assert.ok((answered['answer'] as { savedAt?: number } | undefined)?.savedAt, 'the line carries the answer');
      const ids = wholeLines(mine.seen.out).map((l) => (JSON.parse(l) as { id?: string }).id).filter(Boolean);
      assert.ok(!ids.includes('owner-other'), '--agent leaves out the cards of other agents');
      // The watcher without --agent sees both cards, and --type change leaves out the hello lines and presence.
      const all = await until(() => {
        const lines = wholeLines(changes.seen.out).map((l) => JSON.parse(l) as Record<string, unknown>);
        return lines.some((l) => l['id'] === 'owner-other') && lines.some((l) => l['id'] === 'owner-mine') ? lines : undefined;
      });
      assert.ok(all.every((l) => l['type'] === 'change' && !('card' in l)));
      // A script is not the person: the inbox counts no page for either watcher.
      const person = (await (await h.owner('GET', '/v1/person')).json()) as { pages: number };
      assert.equal(person.pages, 0);
    } finally {
      await mine.stop();
      await changes.stop();
      await h.stop();
    }
  });

  it('refuses --ack as the owner, and says to pair as owner when this machine is not', async () => {
    const h = await start();
    const agentOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'your-attention-'));
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'your-attention-'));
    try {
      const ack = await watching(h.home, '--role', 'owner', '--ack');
      await ack.ended;
      assert.match(ack.seen.err, /An owner watcher can't/);
      assert.equal(ack.child.exitCode, 1);
      fs.writeFileSync(path.join(agentOnly, 'client.json'), JSON.stringify({ url: h.server.url, token: h.agentToken }));
      const agent = await watching(agentOnly, '--role', 'owner');
      await agent.ended;
      assert.match(agent.seen.err, /your-attention pair .* --role owner/);
      assert.equal(agent.child.exitCode, 1);
      const unpaired = await watching(none, '--role', 'owner');
      await unpaired.ended;
      assert.match(unpaired.seen.err, /your-attention pair <url> --role owner/);
      assert.equal(unpaired.child.exitCode, 1);
    } finally {
      await h.stop();
      fs.rmSync(agentOnly, { recursive: true, force: true });
      fs.rmSync(none, { recursive: true, force: true });
    }
  });

  it('keeps only the agent events --type names', async () => {
    const h = await start();
    const w = await watching(h.home, '--agent', 'cli:typed', '--type', 'answer', '--no-card');
    try {
      const c = new Client({ url: h.server.url, token: h.agentToken });
      await c.post({ id: 'watch-typed', agent: 'cli:typed', title: 'Typed?' });
      await h.owner('POST', '/v1/cards/watch-typed/answer', { values: {} });
      const line = await until(() => wholeLines(w.seen.out)[0]);
      assert.equal((JSON.parse(line) as { type: string }).type, 'answer', 'the hello line is left out');
    } finally {
      await w.stop();
      await h.stop();
    }
  });

  it('reads only whole lines, so a chunk that splits one waits for the rest', () => {
    // A chunk can end inside a line, so a line counts once its newline arrives, and the fragment after it waits.
    const cases: [string, string[]][] = [
      ['{"type":"hel', []],
      ['{"a":1}\n{"b":', ['{"a":1}']],
      ['{"a":1}\n', ['{"a":1}']],
    ];
    for (const [out, lines] of cases) assert.deepEqual(wholeLines(out), lines, JSON.stringify(out));
  });

  it('refuses --no-card with --select, and an empty --select', async () => {
    const h = await start();
    try {
      const both = await watching(h.home, '--no-card', '--select', 'id');
      await both.ended;
      assert.match(both.seen.err, /Choose --no-card or --select/);
      assert.equal(both.child.exitCode, 1);
      const empty = await watching(h.home, '--select', ' , ');
      await empty.ended;
      assert.match(empty.seen.err, /--select takes a comma-separated list/);
      assert.equal(empty.child.exitCode, 1);
    } finally {
      await h.stop();
    }
  });
});
