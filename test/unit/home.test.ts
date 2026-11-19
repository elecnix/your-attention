import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { writePrivate } from '../../src/node/home.ts';

describe('writePrivate', () => {
  it('writes a file only its user can read, and leaves no temporary file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-home-'));
    try {
      const file = path.join(dir, 'sub', 'server.json');
      writePrivate(file, '{"url":"http://127.0.0.1:1"}');
      assert.equal(fs.readFileSync(file, 'utf8'), '{"url":"http://127.0.0.1:1"}');
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['server.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A reader that polls for server.json must never see it empty or half written. A rename replaces the file in one
  // step, and it replaces a file this user can't write to, which an in-place write can't do.
  it('replaces the file in one step, so a reader sees the old content or the new', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs file modes that bind this user' : false }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-home-'));
    try {
      const file = path.join(dir, 'server.json');
      fs.writeFileSync(file, 'old', { mode: 0o400 });
      writePrivate(file, 'new');
      assert.equal(fs.readFileSync(file, 'utf8'), 'new');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
