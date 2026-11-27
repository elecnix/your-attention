// `your-attention secret`: adding, listing and removing secret sources, and giving the age source its folders and
// a folder's passphrase, all in a temporary home.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { envelopePath, identityPath } from '../../src/secrets/age-source.ts';
import { loadSecretSources, readSourceEntries } from '../../src/secrets/registry.ts';
import { CLI_ARGS, runCli } from './harness.ts';

const IS_DARWIN = process.platform === 'darwin';
const has = (command: string): boolean => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
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
    assert.match(listed.stdout, /^ *example +stdio +ready +file:\/\//m);

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
    const command = `age -p -o ${JSON.stringify(path.join(dir, 'TOKEN.age'))} ${JSON.stringify(plain)}`;
    const argv = IS_DARWIN ? ['-q', '/dev/null', 'sh', '-c', command] : ['-qec', command, '/dev/null'];
    assert.equal(spawnSync('script', argv, { input: `${PASS}\n${PASS}\n` }).status, 0);
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
    assert.deepEqual(candidates.map((c) => [c.source, c.id]), [['age', 'TOKEN']]);
    const keys = await newSealKeys();
    assert.equal(await openSealed(keys.privateKey, await sources.release('age', 'TOKEN', keys.publicKey)), 'made-up-value');

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
