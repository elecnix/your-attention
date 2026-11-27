// age files for the tests of src/secrets: encrypted to a recipient, or with a passphrase that age only takes on a
// terminal, which `script` provides here the way the vault does.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

/** Whether a command is on the PATH. */
export const has = (command: string): boolean => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;

/** Encrypt the file `source` to a recipient: no terminal, so this is the shape an envelope has. */
export function encryptTo(recipient: string, source: string, out: string): void {
  const made = spawnSync('age', ['-r', recipient, '-o', out, source], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
}

/** Encrypt the file `source` with a passphrase, typed on the terminal `script` gives age. */
export function encryptWithPassphrase(source: string, out: string, passphrase: string): Promise<void> {
  const command = `age -p -o ${JSON.stringify(out)} ${JSON.stringify(source)}`;
  const argv = process.platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', command] : ['-qec', command, '/dev/null'];
  return new Promise((resolve, reject) => {
    const child = spawn('script', argv, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString('utf8')))));
    child.stdin.end(`${passphrase}\n${passphrase}\n`);
  });
}
