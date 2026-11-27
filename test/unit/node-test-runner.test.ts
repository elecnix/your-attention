// `node --test` reports 0 tests and exits 0 when its pattern selects no file, so every test script goes through
// scripts/node-test.ts, which fails on an empty selection.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const runner = path.join(ROOT, 'scripts', 'node-test.ts');
// A test process passes NODE_TEST_CONTEXT to its children, which makes a nested `node --test` report to it instead of stdout.
const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runner, ...args], { cwd: ROOT, encoding: 'utf8', env });

describe('the test runner', () => {
  it('fails when a pattern selects no test file', () => {
    const result = run('--', 'test/no-such-folder/**/*.test.ts');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /selects no test file/);
  });

  it('fails when one of several patterns selects nothing', () => {
    const result = run('--', 'test/unit/age.test.ts', 'test/no-such-folder/*.test.ts');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-such-folder/);
  });

  it('refuses patterns that are not after --', () => {
    const result = run('test/unit/age.test.ts');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /after --/);
  });

  it('passes a flag whose value is a separate argument to node --test', () => {
    const result = run('--test-reporter', 'tap', '--', 'test/unit/age.test.ts');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# pass [1-9]/m);
  });

  it('runs the tests a pattern selects', () => {
    const result = run('--test-reporter=tap', '--', 'test/unit/age.test.ts');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# pass [1-9]/m);
  });

  it('runs every test script in package.json, never a bare node --test', () => {
    const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    for (const [name, command] of Object.entries(scripts)) {
      assert.doesNotMatch(command, /node --test/, `${name} runs node --test directly, which passes on an empty selection`);
    }
    for (const name of ['test:unit', 'test:integration', 'test:cloudflare']) {
      assert.match(scripts[name] ?? '', /scripts\/node-test\.ts/, `${name} goes through scripts/node-test.ts`);
    }
  });
});
