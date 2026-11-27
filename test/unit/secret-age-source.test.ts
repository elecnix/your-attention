// The built-in age source: a folder of *.age files, read with the instance's identity, or with a passphrase kept in an
// envelope encrypted to that identity. The folder is never rewritten, and no release asks for anything.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { ageSource, envelopePath, ensureIdentity, identityPath, writeEnvelope } from '../../src/secrets/age-source.ts';

const IS_DARWIN = process.platform === 'darwin';
const has = (command: string): boolean => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
const POSIX = process.platform !== 'win32';
const NO_AGE = !POSIX ? 'the age source needs a POSIX terminal' : has('age') && has('age-keygen') && has('script') && has('mkfifo') ? false : 'age, age-keygen, script or mkfifo is missing';
const PASS = 'made up passphrase for a test';

const scratch = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function encryptTo(recipient: string, value: string, out: string): void {
  const made = spawnSync('age', ['-r', recipient, '-o', out], { input: value, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
}

function encryptWithPassphrase(value: string, out: string): Promise<void> {
  const plain = `${out}.plain`;
  fs.writeFileSync(plain, value);
  const command = `age -p -o ${JSON.stringify(out)} ${JSON.stringify(plain)}`;
  const argv = IS_DARWIN ? ['-q', '/dev/null', 'sh', '-c', command] : ['-qec', command, '/dev/null'];
  return new Promise((resolve, reject) => {
    const child = spawn('script', argv, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.on('close', (code) => { fs.rmSync(plain); code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString('utf8'))); });
    child.stdin.end(`${PASS}\n${PASS}\n`);
  });
}

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
    encryptTo(recipient, 'made-up-token\n', path.join(dir, 'GITHUB_TOKEN.age'));
    fs.writeFileSync(path.join(dir, 'README'), 'not a secret');
    const source = ageSource({ home, settings: { dirs: [dir] } });
    const found = await source.lookup({ name: 'github-token' });
    assert.equal(found.length, 1);
    assert.deepEqual({ ...found[0], changedAt: undefined }, { id: 'GITHUB_TOKEN', label: 'GITHUB_TOKEN', type: 'file', store: dir, changedAt: undefined });
    assert.deepEqual(await source.lookup({ name: 'README' }), []);
    assert.deepEqual(await source.lookup({ type: 'api-key', host: 'api.example.com' }), []);
    const keys = await newSealKeys();
    assert.equal(await openSealed(keys.privateKey, await source.release('GITHUB_TOKEN', keys.publicKey)), 'made-up-token');
  });

  it('opens a passphrase file through its folder envelope, and leaves the folder byte for byte as it was', async () => {
    const home = scratch('ya-age-home-');
    const dir = scratch('ya-age-dir-');
    await ensureIdentity(home);
    await encryptWithPassphrase('made-up-password', path.join(dir, 'DB_PASSWORD.age'));
    const before = snapshot(dir);
    const source = ageSource({ home, settings: { dirs: [dir] } });
    const keys = await newSealKeys();
    await assert.rejects(source.release('DB_PASSWORD', keys.publicKey), new RegExp(`no passphrase for ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await writeEnvelope(home, dir, PASS);
    assert.ok(fs.existsSync(envelopePath(home, dir)));
    assert.ok(!fs.readFileSync(envelopePath(home, dir)).includes(PASS), 'the envelope holds the passphrase encrypted');
    assert.equal(await openSealed(keys.privateKey, await source.release('DB_PASSWORD', keys.publicKey)), 'made-up-password');
    assert.deepEqual(snapshot(dir), before);
  });

  it('refuses a candidate that is not a file of its folders', async () => {
    const home = scratch('ya-age-home-');
    const dir = scratch('ya-age-dir-');
    await ensureIdentity(home);
    const keys = await newSealKeys();
    await assert.rejects(ageSource({ home, settings: { dirs: [dir] } }).release('../identity', keys.publicKey), /no age file named/);
  });
});
