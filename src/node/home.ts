// Where an inbox and its clients keep their files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir(): string {
  return process.env['YOUR_ATTENTION_HOME'] ?? path.join(os.homedir(), '.your-attention');
}

/** Write a file that only this user can read. It writes a temporary file beside it and renames that over it, so a
 * reader that polls the file, such as a client waiting for server.json, sees the old content or the new, never a
 * file written halfway. */
export function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    renameOver(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Rename `from` over `to`. Windows refuses the rename while another process has `to` open, which a reader does only
 * for a moment, so there it tries again for up to a second. */
function renameOver(from: string, to: string): void {
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || tries >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** A trimmed file in the home directory, or undefined when it is not there. */
export function readHome(name: string, home = homeDir()): string | undefined {
  try { return fs.readFileSync(path.join(home, name), 'utf8').trim(); } catch { return undefined; }
}
