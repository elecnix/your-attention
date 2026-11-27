// `your-attention secret`: adding, listing and removing secret sources, and giving the age source its folders and
// a folder's passphrase, all in a temporary home.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { envelopePath, identityPath } from '../../src/secrets/age-source.ts';
import { loadSecretSources, readSourceEntries } from '../../src/secrets/registry.ts';
import { encryptWithPassphrase, has } from '../age-fixtures.ts';
import { CLI_ARGS, runCli } from './harness.ts';

const NO_AGE = process.platform === 'win32' ? 'the age source needs a POSIX terminal' : has('age') && has('age-keygen') && has('script') && has('mkfifo') ? false : 'age, age-keygen, script or mkfifo is missing';
const EXAMPLE = path.resolve('examples/secret-source-stdio');
const PASS = 'made up passphrase for the CLI';

const homes: string[] = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

function scratch(): { home: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-secret-cli-'));
  homes.push(home);
  return { home, env: { ...process.env, YOUR_ATTENTION_HOME: home, YOUR_ATTENTION_URL: '', YOUR_ATTENTION_TOKEN: '' } };
}

/** Run the CLI with this text on stdin, as a pipe. */
function withStdin(env: NodeJS.ProcessEnv, input: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...CLI_ARGS, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('your-attention secret source', () => {
  it('refuses a GitHub or https origin with a sentence that says they come later', async () => {
    const { env, home } = scratch();
    for (const origin of ['github:someone/source', 'https://example.com/source.tgz']) {
      const r = await runCli(env, 'secret', 'source', 'add', origin, '--name', 'later');
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /comes in a later version/);
    }
    const plain = await runCli(env, 'secret', 'source', 'add', EXAMPLE, '--name', 'plain');
    assert.match(plain.stderr, /file:\/\//);
    assert.deepEqual(readSourceEntries(home), []);
  });

  it('says in a sentence that it cannot read a folder, for the age folder and its passphrase', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a folder this user cannot search' : false }, async () => {
    const { env, home } = scratch();
    const file = path.join(home, 'a-file');
    fs.writeFileSync(file, 'not a folder');
    const locked = path.join(home, 'locked');
    fs.mkdirSync(locked, { mode: 0o000 });
    try {
      for (const target of [path.join(file, 'inside'), path.join(locked, 'inside')]) {
        for (const args of [['age', 'dir', 'add'], ['age', 'passphrase']]) {
          const r = await withStdin(env, '', 'secret', ...args, target);
          assert.equal(r.code, 1, r.stderr);
          assert.match(r.stderr, /is not a folder this user can read/);
          assert.doesNotMatch(r.stderr, /^\s+at /m);
        }
      }
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('adds the example as a stdio source, lists it ready, and removes it', async () => {
    const { env, home } = scratch();
    const origin = pathToFileURL(EXAMPLE).href;
    const added = await runCli(env, 'secret', 'source', 'add', origin, '--name', 'example', '--command', 'node source.ts');
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /example.*ready/);
    assert.deepEqual(readSourceEntries(home), [{ kind: 'secret', name: 'example', form: 'stdio', origin, command: ['node', 'source.ts'] }]);

    const again = await runCli(env, 'secret', 'source', 'add', origin, '--name', 'example', '--command', 'node source.ts');
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already named example/);

    const listed = await runCli(env, 'secret', 'source', 'list');
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^ *age +built-in +(off|ready)/m);
    const shown = EXAMPLE.startsWith(`${os.homedir()}${path.sep}`) ? `~${EXAMPLE.slice(os.homedir().length)}` : EXAMPLE;
    assert.ok(listed.stdout.split('\n').some((l) => /^ *example +stdio +ready +/.test(l) && l.endsWith(shown)), listed.stdout);

    const removed = await runCli(env, 'secret', 'source', 'remove', 'example');
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(readSourceEntries(home), []);
    const refused = await runCli(env, 'secret', 'source', 'remove', 'age');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /built in/);
  });
});

describe('your-attention secret age', { skip: NO_AGE }, () => {
  it('makes the identity on first use, adds a folder, and keeps its passphrase from stdin in an envelope', async () => {
    const { env, home } = scratch();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-secret-dir-'));
    homes.push(dir);
    // A file encrypted with the passphrase, as a folder made by hand would hold.
    const plain = path.join(home, 'plain');
    fs.writeFileSync(plain, 'made-up-value\n');
    await encryptWithPassphrase(plain, path.join(dir, 'TOKEN.age'), PASS);
    fs.rmSync(plain);

    const added = await runCli(env, 'secret', 'age', 'dir', 'add', dir);
    assert.equal(added.code, 0, added.stderr);
    assert.ok(fs.existsSync(identityPath(home)));
    assert.match(added.stdout, /age1\w+/);
    assert.match(added.stdout, /passphrase/);
    assert.deepEqual(readSourceEntries(home), [{ kind: 'secret', name: 'age', builtin: true, settings: { dirs: [dir] } }]);

    const wrong = await withStdin(env, 'not the passphrase\n', 'secret', 'age', 'passphrase', dir);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /does not open/);
    assert.ok(!fs.existsSync(envelopePath(home, dir)));

    const kept = await withStdin(env, `${PASS}\n`, 'secret', 'age', 'passphrase', dir);
    assert.equal(kept.code, 0, kept.stderr);
    assert.ok(fs.existsSync(envelopePath(home, dir)));

    const sources = loadSecretSources({ home, instance: 'laptop' });
    const { candidates } = await sources.lookup({ name: 'TOKEN' });
    const file = path.join(dir, 'TOKEN.age');
    assert.deepEqual(candidates.map((c) => [c.source, c.id, c.label]), [['age', file, 'TOKEN']]);
    const keys = await newSealKeys();
    assert.equal(await openSealed(keys.privateKey, await sources.release('age', file, keys.publicKey)), 'made-up-value');

    const removed = await runCli(env, 'secret', 'age', 'dir', 'remove', dir);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(readSourceEntries(home), [{ kind: 'secret', name: 'age', builtin: true, settings: { dirs: [] } }]);
  });

  it('never takes the passphrase as an argument', async () => {
    const { env } = scratch();
    const r = await runCli(env, 'secret', 'age', 'passphrase', os.tmpdir(), 'hunter2');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /stdin/);
  });
});
