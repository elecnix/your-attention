// The pi launcher: `your-attention pi --tags repo=acme/api,topic=billing -- <pi args>` exports YOUR_ATTENTION_TAGS and
// runs pi with the rest of its arguments unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CLI_ARGS } from './harness.ts';

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-pi-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A pi that records what it was given, then exits with a status the test can see. */
function fakePi(): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pi'), [
    '#!/bin/sh',
    '{',
    '  echo "tags=${YOUR_ATTENTION_TAGS-}"',
    '  for a in "$@"; do echo "arg=$a"; done',
    '} > "$PI_CAPTURE"',
    'exit 3',
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function run(args: string[]): { status: number | null; stderr: string; capture?: string } {
  const capture = path.join(dir, 'capture');
  fs.rmSync(capture, { force: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakePi()}${path.delimiter}${process.env['PATH'] ?? ''}`, PI_CAPTURE: capture };
  // The launcher only sets the variable from --tags. A value this machine happens to carry would otherwise reach pi.
  delete env['YOUR_ATTENTION_TAGS'];
  const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...CLI_ARGS, 'pi', ...args], { env, encoding: 'utf8' });
  return { status: res.status, stderr: res.stderr, ...(fs.existsSync(capture) ? { capture: fs.readFileSync(capture, 'utf8') } : {}) };
}

describe('the pi launcher', () => {
  it('gives pi its arguments unchanged, and its default tags in the environment', () => {
    const r = run(['--tags', 'repo=acme/store,topic=billing', '--', '--version', '--model', 'a model']);
    assert.equal(r.status, 3, 'the launcher exits with the status pi gave');
    assert.equal(r.capture, 'tags=repo=acme/store,topic=billing\narg=--version\narg=--model\narg=a model\n');
  });

  it('runs pi with no tags when there is no --tags', () => {
    const r = run(['--', '--help']);
    assert.equal(r.status, 3);
    assert.equal(r.capture, 'tags=\narg=--help\n');
  });

  it('refuses a malformed --tags before it starts pi', () => {
    const r = run(['--tags', 'novalue', '--', '--version']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /k=v/);
    assert.equal(r.capture, undefined, 'pi never ran');
  });
});
