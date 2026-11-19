// Every command answers --help and -h, and a wrong option gets one line and the usage instead of a stack trace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { COMMANDS } from '../../src/cli-usage.ts';
import { runCli } from './harness.ts';

// An empty home, so no command finds an inbox to talk to: help and usage mistakes must not need one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-help-'));
const env = { ...process.env, YOUR_ATTENTION_HOME: home, YOUR_ATTENTION_URL: '', YOUR_ATTENTION_TOKEN: '' };
after(() => fs.rmSync(home, { recursive: true, force: true }));
const STACK = /^\s+at /m;

/** Run fn on each item, three at a time. Each item starts a Node process, and starting all of them at once takes every
 * core of a CI runner from the test files that run beside this one, such as the channel's startup test. */
async function each<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

describe('help for each command', () => {
  for (const flag of ['--help', '-h']) {
    it(`prints the usage of every command for ${flag}, and exits 0`, async () => {
      await each(COMMANDS, async (c) => {
        const r = await runCli(env, c.name, flag);
        assert.equal(r.code, 0, `${c.name} ${flag}: ${r.stderr}`);
        for (const l of c.lines) assert.ok(r.stdout.includes(`your-attention ${l.syntax}`), `${c.name} ${flag} prints ${l.syntax}`);
        assert.match(r.stdout, /Options:/);
      });
    });
  }

  it('prints help for pair without its url, and for install --help with no harness', async () => {
    const pair = await runCli(env, 'pair', '--help');
    assert.equal(pair.code, 0);
    assert.match(pair.stdout, /--role agent\|owner/);
    const install = await runCli(env, 'install', '--help');
    assert.equal(install.code, 0);
    assert.match(install.stdout, /your-attention install --help <harness>/);
  });

  it('keeps help, and help <command>', async () => {
    const all = await runCli(env, 'help');
    assert.equal(all.code, 0);
    for (const c of COMMANDS) assert.ok(all.stdout.includes(`  ${c.lines[0]!.syntax}`), c.name);
    const one = await runCli(env, 'help', 'pair');
    assert.equal(one.code, 0);
    assert.match(one.stdout, /your-attention pair <url>/);
    assert.match(one.stdout, /--name NAME/);
  });
});

describe('a usage mistake', () => {
  it('names an unknown option on one line, prints the usage to stderr, and exits 2, for every command', async () => {
    await each(COMMANDS, async (c) => {
      const r = await runCli(env, c.name, '--frobnicate');
      assert.equal(r.code, 2, `${c.name}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, STACK, c.name);
      assert.match(r.stderr, new RegExp(`^your-attention ${c.name}: `), c.name);
      assert.ok(r.stderr.includes(`Usage: your-attention ${c.lines[0]!.syntax}`), c.name);
      assert.equal(r.stdout, '', c.name);
    });
  });

  it('says which option needs a value, and which positional is missing or wrong', async () => {
    const cases: [string[], string][] = [
      [['pair', '--frobnicate'], 'your-attention pair: unknown option --frobnicate'],
      [['discover', '--seconds'], 'your-attention discover: --seconds needs a value'],
      [['pair'], 'your-attention pair: '],
      [['pin', 'frob'], 'your-attention pin: '],
      [['telemetry', 'frob'], 'your-attention telemetry: '],
      [['service', 'frob'], 'your-attention service: '],
      [['offer', 'telnet', 'host'], 'your-attention offer: '],
      [['claude-hook', 'frob'], 'your-attention claude-hook: '],
      [['stop', 'extra'], 'your-attention stop: unexpected argument extra'],
      [['telemetry', 'off', '--days=5'], 'your-attention telemetry: --days and --invites go with report'],
      [['telemetry', 'off', '--days', '5'], 'your-attention telemetry: --days and --invites go with report'],
    ];
    await each(cases, async ([args, line]) => {
      const r = await runCli(env, ...args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.ok(r.stderr.startsWith(line), `${args.join(' ')}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, STACK);
    });
  });

  it('names an unknown command, and exits 2', async () => {
    const r = await runCli(env, 'frobnicate');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^your-attention: unknown command frobnicate/);
  });
});
