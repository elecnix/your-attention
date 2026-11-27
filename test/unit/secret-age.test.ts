// Reading age files with no terminal prompt and no plaintext file: an identity file for a store's passphrase
// envelope, and a terminal that `script` provides for a passphrase-encrypted file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { decryptWithIdentity, decryptWithPassphrase, runtimeDir } from '../../src/secrets/age.ts';
import { encryptTo, encryptWithPassphrase as encryptWithPassphraseAs, has } from '../age-fixtures.ts';

/** `script` and `mkfifo` are POSIX tools; the module reads age files through them. */
const POSIX = process.platform !== 'win32';
const HAVE_AGE = POSIX && has('age') && has('age-keygen');
/** The passphrase path needs a terminal somebody else provides, which `script` does on both platforms. */
const HAVE_SCRIPT = POSIX && has('script') && has('mkfifo');
const NO_AGE = !POSIX ? 'reading an age file needs a POSIX terminal' : HAVE_AGE ? false : 'age is not installed';
const NO_SCRIPT = !POSIX ? 'reading an age file needs a POSIX terminal' : HAVE_SCRIPT ? false : 'script or mkfifo is missing';
const PASS = 'correct horse battery staple';

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ya-age-test-'));
}

/** A key pair, written where only this user can read it, as the envelope's identity would be. */
async function keyPair(dir: string): Promise<{ identity: string; recipient: string }> {
  const identity = path.join(dir, 'id.key');
  const made = spawnSync('age-keygen', ['-o', identity], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const text = await fs.readFile(identity, 'utf8');
  const recipient = /public key: (age1\w+)/.exec(text)?.[1];
  assert.ok(recipient, 'age-keygen prints the public key beside the identity');
  return { identity, recipient };
}

const encryptWithPassphrase = (source: string, out: string): Promise<void> => encryptWithPassphraseAs(source, out, PASS);

describe('reading an age file', { skip: NO_AGE }, () => {
  it('opens an identity-protected file with no terminal at all', async () => {
    const dir = await scratch();
    try {
      const { identity, recipient } = await keyPair(dir);
      const source = path.join(dir, 'vault.passphrase');
      await fs.writeFile(source, 'twelve words about horses');
      const encrypted = path.join(dir, 'vault.passphrase.age');
      await encryptTo(recipient, source, encrypted);
      assert.equal(await decryptWithIdentity(encrypted, identity), 'twelve words about horses');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an identity that opens nothing instead of returning an empty secret', async () => {
    const dir = await scratch();
    const cleanup = [dir];
    try {
      const { recipient } = await keyPair(dir);
      const otherDir = await scratch();
      cleanup.push(otherDir);
      const other = await keyPair(otherDir);
      const source = path.join(dir, 'value');
      await fs.writeFile(source, 'not for that key');
      const encrypted = path.join(dir, 'value.age');
      await encryptTo(recipient, source, encrypted);
      await assert.rejects(() => decryptWithIdentity(encrypted, other.identity), /could not decrypt/);
    } finally {
      for (const d of cleanup) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('opens a passphrase-protected file through a terminal, and leaves no file behind', { skip: NO_SCRIPT }, async () => {
    const dir = await scratch();
    const before = await leftovers();
    try {
      const source = path.join(dir, 'value');
      await fs.writeFile(source, 'sk-live-0123456789');
      const encrypted = path.join(dir, 'value.age');
      await encryptWithPassphrase(source, encrypted);
      assert.equal(await decryptWithPassphrase(encrypted, PASS), 'sk-live-0123456789');
      assert.deepEqual(await leftovers(), before, 'the pipe and its directory are gone');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails on a wrong passphrase rather than handing back an empty value', { skip: NO_SCRIPT }, async () => {
    const dir = await scratch();
    try {
      const source = path.join(dir, 'value');
      await fs.writeFile(source, 'sk-live-0123456789');
      const encrypted = path.join(dir, 'value.age');
      await encryptWithPassphrase(source, encrypted);
      await assert.rejects(() => decryptWithPassphrase(encrypted, 'wrong'), /decrypted to nothing|could not decrypt/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('says so when age is not on the PATH', async () => {
    const dir = await scratch();
    try {
      const { identity, recipient } = await keyPair(dir);
      const source = path.join(dir, 'value');
      await fs.writeFile(source, 'x');
      const encrypted = path.join(dir, 'value.age');
      await encryptTo(recipient, source, encrypted);
      await assert.rejects(() => decryptWithIdentity(encrypted, identity, { age: 'age-not-here' }), /not installed/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('where the pipe lives', () => {
  it('takes the temp directory when the runtime directory is set but empty', () => {
    assert.equal(runtimeDir({ XDG_RUNTIME_DIR: '' }), os.tmpdir());
    assert.equal(runtimeDir({ XDG_RUNTIME_DIR: '/run/user/1' }), '/run/user/1');
  });

  it('rejects, rather than crashing the process, when script is not on the PATH', { skip: POSIX ? false : 'mkfifo is POSIX' }, async () => {
    const dir = await scratch();
    try {
      const source = path.join(dir, 'value.age');
      await fs.writeFile(source, 'x');
      // mkfifo runs with this process's PATH, and script with `env`, whose PATH holds no script.
      const env = { PATH: dir, XDG_RUNTIME_DIR: dir };
      await assert.rejects(() => decryptWithPassphrase(source, PASS, { env, timeoutMs: 2000 }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/** The directories this module leaves in the runtime directory, to prove it leaves none. */
async function leftovers(): Promise<string[]> {
  const dir = runtimeDir();
  if (!existsSync(dir)) return [];
  const names = await fs.readdir(dir);
  return names.filter((name) => name.startsWith('ya-age-')).sort();
}
