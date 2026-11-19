// The list `your-attention help` prints and each command's own --help come from one table, so the two never drift.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { COMMANDS, commandHelp, helpText, parseProblem, wantsHelp } from '../../src/cli-usage.ts';

const CLI = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts'), 'utf8');

describe('the usage table', () => {
  it('lists exactly the commands cli.ts handles', () => {
    const cases = [...CLI.matchAll(/^ {2}case '([a-z-]+)':/gm)].map((m) => m[1]).sort();
    assert.deepEqual(COMMANDS.map((c) => c.name).sort(), cases);
  });

  it('prints each line of a command in both the list and its own help', () => {
    const list = helpText('/home');
    for (const c of COMMANDS) {
      const own = commandHelp(c);
      for (const l of c.lines) {
        assert.ok(list.includes(`  ${l.syntax}`), `${l.syntax} is in the list`);
        assert.ok(own.includes(`your-attention ${l.syntax}`), `${l.syntax} is in ${c.name} --help`);
      }
      assert.match(own, /-h, --help/);
    }
  });

  it('starts every summary line in the list at the same column', () => {
    const out = helpText('/home').split('\n');
    for (const c of COMMANDS) {
      for (const l of c.lines) {
        for (const part of l.summary.split('\n')) {
          const row = out.find((o) => o.endsWith(part));
          assert.equal(row?.length, 54 + part.length, `${l.syntax}: ${part}`);
        }
      }
    }
  });

  it('reads parseArgs mistakes as one short line', () => {
    const problem = (args: string[], options: ParseArgsConfig['options'] = {}) => {
      try { parseArgs({ args, options }); return undefined; } catch (e) { return parseProblem(e); }
    };
    assert.equal(problem(['--frobnicate']), 'unknown option --frobnicate');
    assert.equal(problem(['--port'], { port: { type: 'string' } }), '--port needs a value');
    assert.equal(problem(['--wait=1'], { wait: { type: 'boolean' } }), '--wait takes no value');
    assert.equal(problem(['extra']), 'unexpected argument extra');
    assert.equal(parseProblem(new TypeError('a real crash')), undefined);
    // A message this code does not know is passed on as Node wrote it, never guessed as a missing value.
    const repeated = Object.assign(new TypeError("Option '--name <value>' cannot be used multiple times"), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
    assert.equal(parseProblem(repeated), "Option '--name <value>' cannot be used multiple times");
  });

  it('treats --help as a request for help, except where it names a harness, and never after --', () => {
    assert.equal(wantsHelp(['--help']), true);
    assert.equal(wantsHelp(['https://x', '-h']), true);
    assert.equal(wantsHelp(['--', '--help']), false);
    assert.equal(wantsHelp(['--help', 'claude'], true), false);
    assert.equal(wantsHelp(['--help'], true), true);
    assert.equal(wantsHelp(['--help', '--from-source', 'x'], true), true);
  });
});
