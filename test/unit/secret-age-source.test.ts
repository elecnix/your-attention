// The built-in age source: a folder of *.age files, read with the instance's identity, or with a passphrase kept in an
// envelope encrypted to that identity. The folder is never rewritten, and no release asks for anything.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { ageSource, envelopePath, ensureIdentity, identityPath, writeEnvelope } from '../../src/secrets/age-source.ts';
import { encryptTo, encryptWithPassphrase, has } from '../age-fixtures.ts';

const POSIX = process.platform !== 'win32';
const NO_AGE = !POSIX ? 'the age source needs a POSIX terminal' : has('age') && has('age-keygen') && has('script') && has('mkfifo') ? false : 'age, age-keygen, script or mkfifo is missing';
const PASS = 'made up passphrase for a test';

/** Every folder the tests make, removed after the last one: some hold a generated age identity. */
const made: string[] = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** A made-up value in a plain file of its own scratch folder, which a test encrypts into the folder under test. */
const plainFile = (value: string): string => {
  const file = path.join(scratch('ya-age-plain-'), 'plain');
  fs.writeFileSync(file, value);
  return file;
};

/** Each file of a folder with its bytes and its modification time, to show the folder was left as it was. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => {
    const p = path.join(dir, f);
    return [f, `${createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${fs.statSync(p).mtimeMs}`];
  }));
}

describe('the age source', { skip: NO_AGE }, () => {
  it('is off, and says why, until it has an identity and a folder', async () => {
    const home = scratch('ya-age-home-');
    assert.deepEqual(await ageSource({ home, settings: {} }).detect(), { status: 'off', reason: `no identity file at ${identityPath(home)}; run \`your-attention secret age dir add <dir>\` to make one` });
    await ensureIdentity(home);
    assert.deepEqual(await ageSource({ home, settings: {} }).detect(), { status: 'off', reason: 'no folder of age files is set; add one with `your-attention secret age dir add <dir>`' });
    const missing = path.join(home, 'nowhere');
    assert.deepEqual(await ageSource({ home, settings: { dirs: [missing] } }).detect(), { status: 'off', reason: `none of its folders exists: ${missing}` });
    assert.deepEqual(await ageSource({ home, settings: { dirs: [home] }, age: '/made/up/age' }).detect(), { status: 'off', reason: '/made/up/age is not installed, or not on the PATH' });
    assert.deepEqual(await ageSource({ home, settings: { dirs: [home] } }).detect(), { status: 'ready' });
  });

  it('makes one identity, readable only by this user, and keeps it', async () => {
    const home = scratch('ya-age-home-');
    const recipient = await ensureIdentity(home);
    assert.match(recipient, /^age1\w+$/);
    assert.equal(fs.statSync(identityPath(home)).mode & 0o777, 0o600);
    const before = fs.readFileSync(identityPath(home), 'utf8');
    assert.equal(await ensureIdentity(home), recipient);
    assert.equal(fs.readFileSync(identityPath(home), 'utf8'), before);
  });

  it('looks up a file by its name and releases it with the identity', async () => {
    const home = scratch('ya-age-home-');
    const dir = scratch('ya-age-dir-');
    const recipient = await ensureIdentity(home);
    encryptTo(recipient, plainFile('made-up-token\n'), path.join(dir, 'GITHUB_TOKEN.age'));
    fs.writeFileSync(path.join(dir, 'README'), 'not a secret');
    const source = ageSource({ home, settings: { dirs: [dir] } });
    const found = await source.lookup({ name: 'github-token' });
    assert.equal(found.length, 1);
    const file = path.join(dir, 'GITHUB_TOKEN.age');
    assert.deepEqual({ ...found[0], changedAt: undefined }, { id: file, label: 'GITHUB_TOKEN', type: 'file', store: dir, changedAt: undefined });
    assert.deepEqual(await source.lookup({ name: 'README' }), []);
    assert.deepEqual(await source.lookup({ type: 'api-key', host: 'api.example.com' }), []);
    const keys = await newSealKeys();
    assert.equal(await openSealed(keys.privateKey, await source.release(file, keys.publicKey)), 'made-up-token');
  });

  it('gives two candidates when two folders hold a file of the same name, and releases each from its own folder', async () => {
    const home = scratch('ya-age-home-');
    const personal = scratch('ya-age-personal-');
    const work = scratch('ya-age-work-');
    const recipient = await ensureIdentity(home);
    encryptTo(recipient, plainFile('made-up-personal'), path.join(personal, 'openai.age'));
    encryptTo(recipient, plainFile('made-up-work'), path.join(work, 'openai.age'));
    const source = ageSource({ home, settings: { dirs: [personal, work] } });
    const found = await source.lookup({ name: 'OPENAI' });
    assert.deepEqual(found.map((c) => [c.id, c.label, c.store]), [
      [path.join(personal, 'openai.age'), 'openai', personal],
      [path.join(work, 'openai.age'), 'openai', work],
    ]);
    const keys = await newSealKeys();
    assert.equal(await openSealed(keys.privateKey, await source.release(path.join(work, 'openai.age'), keys.publicKey)), 'made-up-work');
    assert.equal(await openSealed(keys.privateKey, await source.release(path.join(personal, 'openai.age'), keys.publicKey)), 'made-up-personal');
  });

  it('opens a passphrase file through its folder envelope, and leaves the folder byte for byte as it was', async () => {
    const home = scratch('ya-age-home-');
    const dir = scratch('ya-age-dir-');
    await ensureIdentity(home);
    await encryptWithPassphrase(plainFile('made-up-password'), path.join(dir, 'DB_PASSWORD.age'), PASS);
    const before = snapshot(dir);
    const source = ageSource({ home, settings: { dirs: [dir] } });
    const keys = await newSealKeys();
    const file = path.join(dir, 'DB_PASSWORD.age');
    await assert.rejects(source.release(file, keys.publicKey), new RegExp(`no passphrase for ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await writeEnvelope(home, dir, PASS);
    assert.ok(fs.existsSync(envelopePath(home, dir)));
    assert.ok(!fs.readFileSync(envelopePath(home, dir)).includes(PASS), 'the envelope holds the passphrase encrypted');
    assert.equal(await openSealed(keys.privateKey, await source.release(file, keys.publicKey)), 'made-up-password');
    assert.deepEqual(snapshot(dir), before);
  });

  it('refuses a candidate that is not a file of its folders', async () => {
    const home = scratch('ya-age-home-');
    const dir = scratch('ya-age-dir-');
    await ensureIdentity(home);
    const keys = await newSealKeys();
    const source = ageSource({ home, settings: { dirs: [dir] } });
    for (const id of ['../identity', identityPath(home), path.join(dir, '..', path.basename(home), 'age', 'identity.txt'), path.join(dir, 'missing.age'), path.join(dir, 'sub', 'nested.age')]) {
      await assert.rejects(source.release(id, keys.publicKey), /no age file at/, id);
    }
  });

  it('neither lists nor releases a symlink that leaves its folder, and keeps one that stays inside', async () => {
    const home = scratch('ya-age-home-');
    const dir = scratch('ya-age-dir-');
    const outside = scratch('ya-age-outside-');
    const recipient = await ensureIdentity(home);
    // The envelope of a folder is exactly the kind of file outside every folder that a link must not reach.
    await writeEnvelope(home, outside, PASS);
    fs.symlinkSync(envelopePath(home, outside), path.join(dir, 'LEAK.age'));
    encryptTo(recipient, plainFile('made-up-inside'), path.join(dir, 'real.age'));
    fs.symlinkSync(path.join(dir, 'real.age'), path.join(dir, 'ALIAS.age'));
    const source = ageSource({ home, settings: { dirs: [dir] } });
    const keys = await newSealKeys();
    assert.deepEqual(await source.lookup({ name: 'LEAK' }), []);
    await assert.rejects(source.release(path.join(dir, 'LEAK.age'), keys.publicKey), /leaves/);
    assert.deepEqual((await source.lookup({ name: 'ALIAS' })).map((c) => c.id), [path.join(dir, 'ALIAS.age')]);
    assert.equal(await openSealed(keys.privateKey, await source.release(path.join(dir, 'ALIAS.age'), keys.publicKey)), 'made-up-inside');
  });
});
