// The proof script's own checks: where a value leaked, and whether the file runs as the command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { leaks } from '../../scripts/prove-secret-sources.ts';

const SCRIPT = path.resolve('scripts/prove-secret-sources.ts');

describe('the proof of secret sources', () => {
  it('names each place that holds the value, from the value the session opened', () => {
    assert.deepEqual(leaks('made-up-value', { lookup: '{"candidates":[]}', stream: '{"x":"made-up-value"}', text: 'granted' }), ['stream']);
    assert.deepEqual(leaks('made-up-value', { lookup: '', stream: '', text: '' }), []);
  });

  it('runs as the command through a path with a space and a symlink, and says how to call it', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya proof '));
    try {
      const link = path.join(dir, 'prove secret sources.ts');
      fs.symlinkSync(SCRIPT, link);
      const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', link], { encoding: 'utf8' });
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /usage: node scripts\/prove-secret-sources\.ts NAME/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
