// `your-attention secret`: the secret sources of this computer, and the folders and passphrases of the age source.
// Everything here changes files in the home folder. No command talks to the inbox, and a running `serve` reads the
// sources again when it starts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCommand, usageError } from '../cli-usage.ts';
import { terminal } from '../node/pin-prompt.ts';
import { decryptWithPassphrase } from './age.ts';
import { ageDirs, ensureIdentity, envelopePath, folderPath, identityPath, isPassphraseFile, writeEnvelope } from './age-source.ts';
import { moduleFile } from './node-source.ts';
import { BUILTINS, editableEntries, instanceName, loadSecretSources, originFolder, readSourceEntries, writeSourceEntries } from './registry.ts';
import type { SourceEntry } from './source.ts';

const COMMAND = 'secret';
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A path as the person wrote it in their home folder, with ~ in front. */
const tilde = (p: string): string => (p === os.homedir() || p.startsWith(`${os.homedir()}${path.sep}`) ? `~${p.slice(os.homedir().length)}` : p);

/** An origin as the list shows it: a folder of this computer as a path, with ~ for the home folder. */
function shownOrigin(origin: string | undefined): string {
  if (!origin) return '';
  try { return tilde(originFolder(origin)); } catch { return origin; }
}

/** Rows in columns, two spaces apart, under an indent. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => `  ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd()).join('\n');
}

async function listSources(home: string): Promise<void> {
  const instance = instanceName();
  const entries = readSourceEntries(home);
  const sources = loadSecretSources({ home, instance, log: () => {} });
  try {
    const listed = await sources.list();
    const rows = listed.map((s) => {
      const entry = entries.find((e) => e.name === s.name);
      const form = s.builtin ? 'built-in' : entry?.form ?? (entry ? 'node' : '');
      const where = s.builtin ? ageDirs(entry?.settings ?? {}).map(tilde).join(', ') : shownOrigin(entry?.origin);
      return [s.name, form, s.status, s.status === 'ready' ? where : s.reason ?? ''];
    });
    console.log(`Secret sources on ${instance}, from ${tilde(path.join(home, 'sources.jsonl'))}\n\n${table([['NAME', 'FORM', 'STATUS', 'FROM, OR WHY NOT'], ...rows])}`);
  } finally {
    sources.close();
  }
}

/** The status of one source right after a change, as one sentence. */
async function statusOf(home: string, name: string): Promise<string> {
  const sources = loadSecretSources({ home, instance: instanceName(), log: () => {} });
  try {
    const s = (await sources.list()).find((l) => l.name === name);
    if (!s) return '';
    return s.status === 'ready' ? `${name} is ready.` : `${name} is ${s.status}: ${s.reason ?? 'no reason given'}.`;
  } finally {
    sources.close();
  }
}

async function addSource(home: string, origin: string | undefined, values: { name?: string; form?: string; command?: string }): Promise<void> {
  if (!origin) usageError(COMMAND, 'source add needs the file:// address of a folder');
  if (/^(github:|https?:)/i.test(origin)) {
    fail(`Installing a source from GitHub or an https address comes in a later version. Clone or download it, then add its folder with a file:// address, such as ${new URL('file:///home/me/your-attention-secret-dev').href}.`);
  }
  let folder: string;
  try {
    folder = originFolder(origin);
  } catch {
    fail(`Give the source as a file:// address, such as ${pathToFileURL(path.resolve(origin)).href}.`);
  }
  if (!fs.existsSync(folder)) fail(`Nothing is at ${folder}.`);
  const form = values.form ?? (values.command ? 'stdio' : 'node');
  if (form !== 'node' && form !== 'stdio') usageError(COMMAND, `--form takes node or stdio, not ${form}`);
  if (form === 'stdio' && !values.command) usageError(COMMAND, 'a stdio source needs --command, the executable to start in its folder');
  if (form === 'node' && values.command) usageError(COMMAND, '--command goes with --form stdio');
  const name = values.name ?? path.basename(folder).replace(/^your-attention-secret-/, '');
  if (!NAME.test(name)) fail(`${name} is not a name a source can take: use letters, digits, - and _, up to 40 characters, with --name.`);
  if (BUILTINS.some((b) => b.name === name)) fail(`${name} is the name of a built-in source. Choose another with --name.`);
  const entries = editable(home);
  if (entries.some((e) => e.name === name)) fail(`A source is already named ${name}. Remove it first, or choose another name with --name.`);
  if (form === 'node') {
    try { moduleFile(folder); } catch (e) { fail(`The node source cannot load: ${(e as Error).message}.`); }
  }
  const entry: SourceEntry = { kind: 'secret', name, form, origin: new URL(origin).href, ...(form === 'stdio' ? { command: values.command!.trim().split(/\s+/) } : {}) };
  writeSourceEntries(home, [...entries, entry]);
  console.log(`Added the ${form} source ${name}. ${await statusOf(home, name)}`);
}

function removeSource(home: string, name: string | undefined): void {
  if (!name) usageError(COMMAND, 'source remove needs the name of a source');
  if (BUILTINS.some((b) => b.name === name)) fail(`${name} is built in, so it cannot be removed. It is off while it has no folder: remove its folders with \`your-attention secret age dir remove <dir>\`.`);
  const entries = editable(home);
  if (!entries.some((e) => e.name === name)) fail(`No source is named ${name}. \`your-attention secret source list\` lists them.`);
  writeSourceEntries(home, entries.filter((e) => e.name !== name));
  console.log(`Removed the source ${name}. Its folder is as it was.`);
}

/** The entries of sources.jsonl for a change, or a stop with the sentence that names a line that doesn't parse. */
function editable(home: string): SourceEntry[] {
  try { return editableEntries(home); } catch (e) { fail((e as Error).message); }
}

/** The age source's folders, from an entries file that a change may rewrite. */
const ageDirsToChange = (home: string): string[] => ageDirs(editable(home).find((e) => e.builtin && e.name === 'age')?.settings ?? {});

/** Change the age source's folders, keeping the rest of its entry. */
function setAgeDirs(home: string, change: (dirs: string[]) => string[]): void {
  const entries = editable(home);
  const current = entries.find((e) => e.builtin && e.name === 'age');
  const settings = { ...current?.settings, dirs: change(ageDirs(current?.settings ?? {})) };
  const entry: SourceEntry = { kind: 'secret', name: 'age', builtin: true, settings };
  writeSourceEntries(home, current ? entries.map((e) => (e === current ? entry : e)) : [entry, ...entries]);
}

/** The age files of a folder that were encrypted with a passphrase. */
function passphraseFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort().filter((f) => f.endsWith('.age')).map((f) => path.join(dir, f)).filter((f) => {
      try { return isPassphraseFile(f); } catch { return false; }
    });
  } catch {
    return [];
  }
}

/** Stop with a sentence unless `folder` is a folder this user can open. A stat refused with EACCES or ENOTDIR is that too. */
function requireFolder(folder: string): void {
  let isFolder = false;
  try {
    isFolder = fs.statSync(folder).isDirectory();
    if (isFolder) fs.accessSync(folder, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    isFolder = false;
  }
  if (!isFolder) fail(`${folder} is not a folder this user can read.`);
}

async function addAgeDir(home: string, dir: string | undefined): Promise<void> {
  if (!dir) usageError(COMMAND, 'age dir add needs a folder');
  const folder = folderPath(dir);
  requireFolder(folder);
  // Before the identity: a file this command can't rewrite stops it with nothing made.
  editable(home);
  const recipient = await ensureIdentity(home);
  setAgeDirs(home, (dirs) => (dirs.includes(folder) ? dirs : [...dirs, folder]));
  const lines = [
    `The age source reads the *.age files of ${tilde(folder)}.`,
    `Its identity is ${tilde(identityPath(home))}. A file encrypted to ${recipient} opens with it.`,
  ];
  if (passphraseFiles(folder).length > 0 && !fs.existsSync(envelopePath(home, folder))) {
    lines.push(`Some files there are encrypted with a passphrase. Give it once with \`your-attention secret age passphrase ${tilde(folder)}\`, which reads it on stdin.`);
  }
  console.log(lines.join('\n'));
}

function removeAgeDir(home: string, dir: string | undefined): void {
  if (!dir) usageError(COMMAND, 'age dir remove needs a folder');
  const folder = folderPath(dir);
  if (!ageDirsToChange(home).includes(folder)) fail(`The age source does not read ${folder}.`);
  setAgeDirs(home, (dirs) => dirs.filter((d) => d !== folder));
  fs.rmSync(envelopePath(home, folder), { force: true });
  console.log(`The age source no longer reads ${tilde(folder)}. Its files are as they were.`);
}

/** The passphrase, from a terminal without echo, or from a pipe without its last line break. Never from argv. */
async function readPassphrase(dir: string): Promise<string> {
  if (process.stdin.isTTY) {
    const t = terminal();
    try { return await t.askHidden(`Passphrase for ${tilde(dir)}: `); } finally { t.close(); }
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function setPassphrase(home: string, dir: string | undefined): Promise<void> {
  if (!dir) usageError(COMMAND, 'age passphrase needs a folder');
  const folder = folderPath(dir);
  requireFolder(folder);
  const passphrase = await readPassphrase(folder);
  if (!passphrase) fail('No passphrase came on stdin, so nothing changed.');
  // Try it on one file first, so a typo never lands in the envelope.
  const [probe] = passphraseFiles(folder);
  if (probe) {
    try { await decryptWithPassphrase(probe, passphrase); } catch { fail(`That passphrase does not open ${tilde(probe)}, so nothing changed.`); }
  }
  await writeEnvelope(home, folder, passphrase);
  const reads = ageDirs(readSourceEntries(home).find((e) => e.builtin && e.name === 'age')?.settings ?? {}).includes(folder);
  console.log(`Kept the passphrase of ${tilde(folder)} in ${tilde(envelopePath(home, folder))}, encrypted to the identity.${reads ? '' : ` Add the folder with \`your-attention secret age dir add ${tilde(folder)}\` so the age source reads it.`}`);
}

export async function secretCommand(args: string[], home: string): Promise<void> {
  const { values, positionals } = parseCommand(COMMAND, {
    args,
    allowPositionals: true,
    options: { name: { type: 'string' }, form: { type: 'string' }, command: { type: 'string' } },
  });
  const [group, action, ...more] = positionals;
  const extra = (allowed: number): void => {
    if (more.length > allowed) usageError(COMMAND, `unexpected argument ${more[allowed]}`);
  };
  if (group === 'source') {
    if (action === 'list' || action === undefined) { extra(0); return listSources(home); }
    if (action === 'add') { extra(1); return addSource(home, more[0], values); }
    if (action === 'remove') { extra(1); return removeSource(home, more[0]); }
    usageError(COMMAND, `unknown subcommand source ${action}`);
  }
  if (group === 'age') {
    if (action === 'dir' && more[0] === 'add') { extra(2); return addAgeDir(home, more[1]); }
    if (action === 'dir' && more[0] === 'remove') { extra(2); return removeAgeDir(home, more[1]); }
    if (action === 'passphrase') {
      if (more.length > 1) usageError(COMMAND, 'age passphrase reads the passphrase on stdin, never as an argument');
      return setPassphrase(home, more[0]);
    }
    usageError(COMMAND, `unknown subcommand age ${[action, ...more].filter(Boolean).join(' ')}`);
  }
  usageError(COMMAND, group ? `unknown subcommand ${group}` : 'give source or age');
}
