// Where an inbox and its clients keep their files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir(): string {
  return process.env['YOUR_ATTENTION_HOME'] ?? path.join(os.homedir(), '.your-attention');
}

/** Write a file that only this user can read. */
export function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
