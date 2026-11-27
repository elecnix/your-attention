// The built-in age source. It reads the *.age files of the folders in its `dirs` setting, and opens each one with the
// instance's identity, or with the passphrase that the folder's envelope keeps encrypted to that identity. So a
// release asks nothing, and the folder's files stay as they are. SPEC.md#the-age-source holds the contract.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealValue } from '../core/sealed.ts';
import type { SecretQuery, SourceCandidate } from '../core/secret-sources.ts';
import { decryptWithIdentity, decryptWithPassphrase, firstLine, run } from './age.ts';
import type { Detected, SecretSource } from './source.ts';

export interface AgeSourceOptions {
  home: string;
  settings: Record<string, unknown>;
  /** The `age` binary, `age` on the PATH by default. */
  age?: string;
  /** The `age-keygen` binary, beside it by default. */
  ageKeygen?: string;
}

export const identityPath = (home: string): string => path.join(home, 'age', 'identity.txt');

/** A folder as the settings name it, with `~/` read as the home folder. */
export function folderPath(dir: string): string {
  return path.resolve(dir === '~' ? os.homedir() : dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir);
}

/** Where the passphrase of a folder is kept, encrypted to the identity: one file per folder, named by its path. */
export function envelopePath(home: string, dir: string): string {
  return path.join(home, 'age', 'envelopes', `${createHash('sha256').update(folderPath(dir)).digest('hex')}.age`);
}

/** The folders of the settings, in order. */
export function ageDirs(settings: Record<string, unknown>): string[] {
  const dirs = settings['dirs'];
  return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string' && d !== '').map(folderPath) : [];
}

/** The recipient of the instance's identity, made with age-keygen the first time. The file is readable only by this user. */
export async function ensureIdentity(home: string, ageKeygen = 'age-keygen'): Promise<string> {
  const file = identityPath(home);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const made = await run(ageKeygen, ['-o', file]);
    if (made.code !== 0) throw new Error(`age-keygen could not make ${file}: ${firstLine(made.stderr)}`);
    fs.chmodSync(file, 0o600);
  }
  const shown = await run(ageKeygen, ['-y', file]);
  if (shown.code !== 0) throw new Error(`age-keygen could not read ${file}: ${firstLine(shown.stderr)}`);
  return shown.stdout.trim();
}

/** Keep a folder's passphrase in its envelope, encrypted to the identity. The passphrase never reaches argv or a file. */
export async function writeEnvelope(home: string, dir: string, passphrase: string, age = 'age'): Promise<string> {
  const recipient = await ensureIdentity(home);
  const file = envelopePath(home, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const made = await run(age, ['-r', recipient, '-o', tmp], { input: passphrase });
  if (made.code !== 0) { fs.rmSync(tmp, { force: true }); throw new Error(`age could not write the envelope: ${firstLine(made.stderr)}`); }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

/** Whether an age file was encrypted with a passphrase, read from its header, in the binary or the armored form. */
export function isPassphraseFile(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  let head: string;
  try {
    const buf = Buffer.alloc(4096);
    head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
  const armor = /^-----BEGIN AGE ENCRYPTED FILE-----\r?\n([\s\S]*)/.exec(head);
  if (armor) head = Buffer.from((armor[1] ?? '').split(/-----END/)[0]!.replace(/\s+/g, ''), 'base64').toString('latin1');
  const header = head.split('\n---')[0] ?? '';
  return /\n-> scrypt /.test(header);
}

/** A name as a query and a file both write it, so DATABASE_URL finds database-url.age. */
const normal = (name: string): string => name.toLowerCase().replace(/[-.\s]/g, '_');

/** The file a candidate's id names, when it is an *.age file directly inside one of the folders, and nowhere else. */
function findFile(dirs: string[], id: string): { dir: string; file: string } | undefined {
  if (!path.isAbsolute(id)) return undefined;
  const file = path.resolve(id);
  const dir = path.dirname(file);
  const name = path.basename(file);
  if (file !== id || !dirs.includes(dir) || !name.endsWith('.age') || name.startsWith('.')) return undefined;
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? { dir, file } : undefined;
}

export function ageSource(options: AgeSourceOptions): SecretSource {
  const { home } = options;
  const age = options.age ?? 'age';
  const dirs = ageDirs(options.settings);
  const identity = identityPath(home);

  return {
    async detect(): Promise<Detected> {
      // run rejects with "age is not installed, or not on the PATH" when there is no such command.
      try { await run(age, ['--version']); } catch (e) { return { status: 'off', reason: (e as Error).message }; }
      if (!fs.existsSync(identity)) return { status: 'off', reason: `no identity file at ${identity}; run \`your-attention secret age dir add <dir>\` to make one` };
      if (dirs.length === 0) return { status: 'off', reason: 'no folder of age files is set; add one with `your-attention secret age dir add <dir>`' };
      if (!dirs.some((d) => fs.existsSync(d))) return { status: 'off', reason: `none of its folders exists: ${dirs.join(', ')}` };
      return { status: 'ready' };
    },

    async lookup(query: SecretQuery): Promise<SourceCandidate[]> {
      // An age file says nothing of a type or a host, so only a name finds one.
      if (!query.name || query.host || (query.type && query.type !== 'file')) return [];
      const wanted = normal(query.name);
      const found: SourceCandidate[] = [];
      // Each file is its own candidate, so two folders that hold openai.age give two, each named by its path.
      for (const dir of new Set(dirs)) {
        let names: string[];
        try { names = fs.readdirSync(dir).sort(); } catch { continue; }
        for (const f of names) {
          if (!f.endsWith('.age') || f.startsWith('.')) continue;
          const label = f.slice(0, -'.age'.length);
          if (normal(label) !== wanted) continue;
          const file = path.join(dir, f);
          const stat = fs.statSync(file, { throwIfNoEntry: false });
          if (!stat?.isFile()) continue;
          found.push({ id: file, label, type: 'file', store: dir, changedAt: Math.round(stat.mtimeMs) });
        }
      }
      return found;
    },

    async release(id, publicKey) {
      const hit = findFile(dirs, id);
      if (!hit) throw new Error(`The age source has no age file at ${id} in its folders.`);
      let value: string;
      if (isPassphraseFile(hit.file)) {
        const envelope = envelopePath(home, hit.dir);
        if (!fs.existsSync(envelope)) throw new Error(`The age source has no passphrase for ${hit.dir}. Give it one with \`your-attention secret age passphrase ${hit.dir}\`.`);
        const passphrase = await decryptWithIdentity(envelope, identity, { age });
        value = await decryptWithPassphrase(hit.file, passphrase, { age });
      } else {
        value = await decryptWithIdentity(hit.file, identity, { age });
      }
      // A file written by `echo` ends with a newline, which no variable means to hold.
      return sealValue(publicKey, value.replace(/\r?\n$/, ''));
    },
  };
}
