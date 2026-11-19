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

/** Run fn on each item, three at a time. Each item starts a Node process, and starting all of them at once takes every
 * core of a CI runner from the test files that run beside this one, such as the channel's startup test. */
async function each<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

/** Run the command, and check its exit code and that stderr carries no stack frame. */
async function expectExit(code: number, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await runCli(env, ...args);
  const label = `your-attention ${args.join(' ')}: ${r.stderr}`;
  assert.equal(r.code, code, label);
  assert.doesNotMatch(r.stderr, /^\s+at /m, label);
  return r;
}

describe('help for each command', () => {
  for (const flag of ['--help', '-h']) {
    it(`prints the usage of every command for ${flag}, and exits 0`, async () => {
      await each(COMMANDS, async (c) => {
        const { stdout } = await expectExit(0, [c.name, flag]);
        for (const l of c.lines) assert.ok(stdout.includes(`your-attention ${l.syntax}`), `${c.name} ${flag} prints ${l.syntax}`);
        assert.match(stdout, /Options:/);
      });
    });
  }

  it('prints help for pair without its url, for install --help alone, and for help and help <command>', async () => {
    const cases: [string[], string[]][] = [
      [['pair', '--help'], ['--role agent|owner']],
      [['install', '--help'], ['your-attention install --help <harness>']],
      [['help'], COMMANDS.map((c) => `  ${c.lines[0]!.syntax}`)],
      [['help', 'pair'], ['your-attention pair <url>', '--name NAME']],
    ];
    await each(cases, async ([args, texts]) => {
      const { stdout } = await expectExit(0, args);
      for (const text of texts) assert.ok(stdout.includes(text), `${args.join(' ')} prints ${text}`);
    });
  });
});

describe('a usage mistake', () => {
  it('names an unknown option on one line, prints the usage to stderr, and exits 2, for every command', async () => {
    await each(COMMANDS, async (c) => {
      const { stdout, stderr } = await expectExit(2, [c.name, '--frobnicate']);
      assert.match(stderr, new RegExp(`^your-attention ${c.name}: `), c.name);
      assert.ok(stderr.includes(`Usage: your-attention ${c.lines[0]!.syntax}`), c.name);
      assert.equal(stdout, '', c.name);
    });
  });

  it('says which option needs a value, which positional is missing or wrong, and which command is unknown', async () => {
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
      [['frobnicate'], 'your-attention: unknown command frobnicate'],
    ];
    await each(cases, async ([args, line]) => {
      const { stderr } = await expectExit(2, args);
      assert.ok(stderr.startsWith(line), `${args.join(' ')}: ${stderr}`);
    });
  });
});
