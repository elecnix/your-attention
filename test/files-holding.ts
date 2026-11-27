// The search that proves a secret never reached the disk: every file under a folder whose bytes contain the value. The
// tests of secrets and privileged actions, and scripts/prove-secret-sources.ts on a real inbox, share it.
import fs from 'node:fs';
import path from 'node:path';

/** A file's bytes, or undefined when it went between the listing and the read, as a SQLite journal does. */
function readIfThere(p: string): Buffer | undefined {
  try { return fs.readFileSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}

/** Every file under `dir` whose bytes contain `value`. */
export function filesHolding(dir: string, value: string): string[] {
  const needle = Buffer.from(value);
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && readIfThere(p)?.includes(needle)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
