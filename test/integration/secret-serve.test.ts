// `your-attention serve` runs the secret sources of its home: the proof script posts a card that lists the age source's
// candidate, the owner grants it, and the session opens the sealed value in memory, with no file holding it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { prove } from '../../scripts/prove-secret-sources.ts';
import { identityPath } from '../../src/secrets/age-source.ts';
import { encryptTo, has } from '../age-fixtures.ts';
import { runCli, serveForTest } from './harness.ts';

const NO_AGE = process.platform === 'win32' ? 'the age source needs a POSIX terminal' : has('age') && has('age-keygen') ? false : 'age or age-keygen is missing';
const VALUE = 'made-up-value-for-the-serve-test';

const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('your-attention serve with secret sources', { skip: NO_AGE }, () => {
  it('offers the age source, and a granted card hands the session the value sealed, never as a file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-serve-secrets-'));
    dirs.push(dir);
    let yaHome = '';
    const server = await serveForTest('ya-serve-secret-', async (env, home) => {
      yaHome = home;
      const added = await runCli(env, 'secret', 'age', 'dir', 'add', dir);
      assert.equal(added.code, 0, added.stderr);
      const recipient = spawnSync('age-keygen', ['-y', identityPath(home)], { encoding: 'utf8' }).stdout.trim();
      const plain = path.join(dir, 'plain');
      fs.writeFileSync(plain, VALUE);
      encryptTo(recipient, plain, path.join(dir, 'PROOF_TOKEN.age'));
      fs.rmSync(plain);
    });
    try {
      const result = await prove({ url: server.url, agentToken: server.read('agent-token'), ownerToken: server.read('owner-token'), name: 'PROOF_TOKEN', expected: VALUE, home: yaHome, log: () => {} });
      assert.equal(result.ok, true, result.lines.join('\n'));
      assert.ok(!result.lines.join('\n').includes(VALUE), 'the proof never prints the value');
    } finally {
      await server.close();
    }
  });
});
