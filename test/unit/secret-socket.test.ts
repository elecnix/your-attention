// The Claude Code channel's socket for secrets: one token per command, and a socket that a later channel of the same
// session took over survives the earlier channel's close.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ask, exportLines, rewrite, serveSecrets, socketPath } from '../../src/integrations/claude/secret-socket.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';

/** A runtime folder short enough for a socket path on macOS. */
const runtime = (): string => fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'ya-sk-'));

describe('the secrets socket of the Claude Code channel', { skip: process.platform === 'win32' }, () => {
  it('hands out a token only while a grant lives, and each token reads the variables once', async () => {
    const dir = runtime();
    const env = { XDG_RUNTIME_DIR: dir };
    const secrets = new SecretRequests();
    const served = await serveSecrets(secrets, 'claude:s1', 's1', env);
    try {
      assert.deepEqual(await ask(served.path, { op: 'token' }), {}, 'no grant, no token');
      assert.equal(served.path, socketPath('s1', env));
      assert.equal(fs.statSync(served.path).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(served.path)).mode & 0o777, 0o700);
    } finally {
      served.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the socket of a later channel of the same session in place when the earlier one closes', async () => {
    const dir = runtime();
    const env = { XDG_RUNTIME_DIR: dir };
    const first = await serveSecrets(new SecretRequests(), 'claude:s2', 's2', env);
    const second = await serveSecrets(new SecretRequests(), 'claude:s2', 's2', env);
    try {
      first.close();
      assert.ok(fs.existsSync(second.path), 'the later channel keeps its socket');
      assert.deepEqual(await ask(second.path, { op: 'token' }), {}, 'and it still answers');
    } finally {
      second.close();
      assert.equal(fs.existsSync(second.path), false);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unknown token with a line that fails, and writes one export per variable', () => {
    assert.match(exportLines({ error: 'this token is unknown, used or expired' }), /did not reach the command: this token is unknown, used or expired' >&2; false$/);
    assert.equal(exportLines({ env: { API_KEY: "it's-not-real", 'BAD NAME': 'x' } }), "export API_KEY='it'\\''s-not-real'\ntrue");
  });

  it('runs the command after a newline, so a command without a trailing semicolon still closes the group', () => {
    const out = rewrite('git status', '/run/s.sock', 'tok', ['node', 'reader.ts']);
    assert.equal(out, `eval "$('node' 'reader.ts' '/run/s.sock' 'tok')" && {\ngit status\n}`);
  });
});
