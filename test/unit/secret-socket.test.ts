// The Claude Code channel's socket for secrets: one token per command, and a socket that a later channel of the same
// session took over survives the earlier channel's close.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { ask, exportLines, rewrite, serveSecrets, socketDir, socketPath } from '../../src/integrations/claude/secret-socket.ts';
import { handle, READER } from '../../src/integrations/claude/secret-hook.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { newSealKeys, sealValue } from '../../src/core/sealed.ts';
import type { Answer, Card } from '../../src/core/types.ts';

const socketDirOf = (runtimeDir: string): string => socketDir({ XDG_RUNTIME_DIR: runtimeDir });

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
    assert.ok(out.startsWith(`eval "$('node' 'reader.ts' '/run/s.sock' 'tok')" && {\n`), out);
    assert.ok(out.includes('\ngit status\n}\n'), out);
  });

  it('reports a failed command as text and ends with status 0, so the hook that masks its output still runs', () => {
    // A reader that prints what the channel would, without a channel.
    const reader = ['sh', '-c', 'printf "%s\\n" "export K=value-not-real" true', 'reader'];
    const run = spawnSync('bash', ['-c', rewrite('printf "%s" "$K"; cd /; false', '/run/s.sock', 'tok', reader) + '\npwd'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, 'value-not-real/\n', 'the cd still holds after the command');
    assert.equal(run.stderr, 'Exit code 1\n');
    // A command that runs exit itself skips the tail, and the EXIT trap reports it the same way, in both shells.
    for (const shell of ['bash', 'zsh']) {
      if (spawnSync(shell, ['-c', 'true']).error) continue;
      const exited = spawnSync(shell, ['-c', rewrite('printf "%s" "$K"; exit 3', '/run/s.sock', 'tok', reader)], { encoding: 'utf8' });
      assert.equal(exited.status, 0, shell);
      assert.equal(exited.stdout, 'value-not-real', shell);
      assert.equal(exited.stderr, 'Exit code 3\n', shell);
    }
    const ok = spawnSync('bash', ['-c', rewrite('true', '/run/s.sock', 'tok', reader)], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.equal(ok.stderr, '', 'a command that succeeds reports nothing');
  });

  it('gives a background command the variables too, since secret-post masks the tool that reads its output', async () => {
    const dir = runtime();
    const env = { XDG_RUNTIME_DIR: dir };
    const secrets = new SecretRequests();
    const served = await serveSecrets(secrets, 'claude:s4', 's4', env);
    try {
      const { publicKey, privateKey } = await newSealKeys();
      secrets.remember('k4', privateKey);
      const card = { id: 'k4', agent: 'claude:s4', title: 'Key?', kind: 'question', secrets: ['K'], createdAt: Date.now() } as unknown as Card;
      await secrets.receive(card, { values: { K: await sealValue(publicKey, 'value-not-real') }, answeredAt: Date.now() } as unknown as Answer);
      const input = (background: boolean) => ({ session_id: 's4', tool_name: 'Bash', tool_input: { command: 'printf "%s" "$K"', run_in_background: background } });
      assert.ok(await handle('secret-pre', input(false), env), 'a foreground command gets the variables');
      assert.ok(await handle('secret-pre', input(true), env), 'and so does a background one');
    } finally {
      served.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('masks the output of any tool, such as Read on a file a command wrote, while the session holds a grant', async () => {
    const dir = runtime();
    const env = { XDG_RUNTIME_DIR: dir };
    const secrets = new SecretRequests();
    const served = await serveSecrets(secrets, 'claude:s5', 's5', env);
    try {
      const { publicKey, privateKey } = await newSealKeys();
      secrets.remember('k5', privateKey);
      const card = { id: 'k5', agent: 'claude:s5', title: 'Key?', kind: 'question', secrets: ['K'], createdAt: Date.now() } as unknown as Card;
      await secrets.receive(card, { values: { K: await sealValue(publicKey, 'value-not-real') }, answeredAt: Date.now() } as unknown as Answer);
      const read = { type: 'text', file: { filePath: '/tmp/x', content: 'K=value-not-real\n', numLines: 1 } };
      const out = await handle('secret-post', { session_id: 's5', tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, tool_response: read }, env) as { hookSpecificOutput: { updatedToolOutput: typeof read } };
      assert.deepEqual(out.hookSpecificOutput.updatedToolOutput, { type: 'text', file: { filePath: '/tmp/x', content: 'K=[secret K]\n', numLines: 1 } });
    } finally {
      served.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the plugin runner skip the CLI when this user has no secrets socket, in the folder socketDir names', () => {
    const dir = runtime();
    try {
      const runner = path.join(import.meta.dirname, '..', '..', 'bin', 'claude-plugin-runner.js');
      // With an empty PATH, the runner fails if it tries to start the CLI, so status 0 means it never did.
      const run = spawnSync(process.execPath, [runner, 'claude-hook', 'secret-post'], { env: { XDG_RUNTIME_DIR: dir, PATH: '' }, input: '{}', encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const named = spawnSync(process.execPath, ['--input-type=module', '-e', `import { secretsDir } from ${JSON.stringify(runner.replace('claude-plugin-runner.js', 'secrets-dir.js'))}; process.stdout.write(secretsDir(process.env))`], { env: { XDG_RUNTIME_DIR: dir }, encoding: 'utf8' });
      assert.equal(named.stdout, socketDirOf(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('withholds the output of a rewritten command when the channel does not mask it', async () => {
    const dir = runtime();
    const env = { XDG_RUNTIME_DIR: dir };
    // A file where the socket should be: nothing answers on it.
    fs.mkdirSync(path.dirname(socketPath('s3', env)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(socketPath('s3', env), '');
    try {
      const rewritten = rewrite('printf "%s" "$K"', socketPath('s3', env), 'tok', READER);
      const out = await handle('secret-post', { session_id: 's3', tool_name: 'Bash', tool_input: { command: rewritten }, tool_response: { stdout: 'value-not-real', stderr: '', interrupted: false, isImage: false } }, env) as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } };
      assert.match(out.hookSpecificOutput.updatedToolOutput.stdout, /withheld/);
      assert.doesNotMatch(JSON.stringify(out), /value-not-real/);
      const plain = await handle('secret-post', { session_id: 's3', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a', stderr: '', interrupted: false, isImage: false } }, env);
      assert.equal(plain, undefined, 'a command the hook did not rewrite got no secret, so its output goes through');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
