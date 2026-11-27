// The secret sources of this computer: the built-in ones, and each entry of ~/.your-attention/sources.jsonl in its
// form. `serve` hands the result to the inbox as its SecretSources, and the CLI lists it. SPEC.md#secret-sources holds
// the contract.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSealed } from '../core/sealed.ts';
import type { Candidate, SecretQuery, SecretSources, SourceCandidate, SourceInfo } from '../core/secret-sources.ts';
import type { Sealed } from '../core/types.ts';
import { writePrivate } from '../node/home.ts';
import { ageSource } from './age-source.ts';
import { loadNodeSource } from './node-source.ts';
import { SOURCE_CALL_TIMEOUT_MS, type Detected, type SecretSource, type SourceEntry } from './source.ts';
import { stdioSource } from './stdio-source.ts';

/** A source this program ships. Its entry in sources.jsonl, when there is one, gives only its settings. */
export interface Builtin {
  name: string;
  create(settings: Record<string, unknown>, context: { home: string }): SecretSource;
}

export interface RegistryOptions {
  /** The folder that holds sources.jsonl, ~/.your-attention by default. */
  home: string;
  /** The name of this computer, which each candidate and each source carries. */
  instance: string;
  /** The built-in sources, in the order they answer. The age source by default. */
  builtins?: Builtin[];
  /** How long one call to a source may take, 30 seconds by default. */
  timeoutMs?: number;
  /** Where a stdio source's stderr goes, one line at a time. */
  log?: (line: string) => void;
}

export const SOURCES_FILE = 'sources.jsonl';

export const BUILTINS: Builtin[] = [{ name: 'age', create: (settings, { home }) => ageSource({ home, settings }) }];

/** The name of this computer as a candidate shows it, without the .local suffix macOS adds. */
export function instanceName(): string {
  return os.hostname().replace(/\.local$/i, '');
}

type Line = { entry: SourceEntry } | { problem: string; line: number };

/** Each line of sources.jsonl, read as an entry or as the reason it is not one. */
function readLines(home: string): Line[] {
  let text: string;
  try { text = fs.readFileSync(path.join(home, SOURCES_FILE), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((raw, i): Line[] => {
    if (!raw.trim()) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return [{ problem: `line ${i + 1} of ${SOURCES_FILE} is not JSON`, line: i + 1 }]; }
    const e = parsed as Partial<SourceEntry> | null;
    if (!e || typeof e !== 'object' || e.kind !== 'secret' || typeof e.name !== 'string' || !e.name) {
      return [{ problem: `line ${i + 1} of ${SOURCES_FILE} is not a secret source with a name`, line: i + 1 }];
    }
    return [{ entry: e as SourceEntry }];
  });
}

/** The entries of sources.jsonl that read as entries, in file order. */
export function readSourceEntries(home: string): SourceEntry[] {
  return readLines(home).flatMap((l) => ('entry' in l ? [l.entry] : []));
}

/** Replace sources.jsonl with these entries, readable only by this user. */
export function writeSourceEntries(home: string, entries: SourceEntry[]): void {
  writePrivate(path.join(home, SOURCES_FILE), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

/** The folder a `file://` origin names. Version 1 takes no other scheme. */
export function originFolder(origin: string | undefined): string {
  if (!origin) throw new Error('the entry has no origin');
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error(`the origin ${origin} is not an address`); }
  if (url.protocol !== 'file:') throw new Error(`the origin ${origin} is not a file:// address, and version 1 loads sources only from a folder on this computer`);
  // fileURLToPath gives C:\folder on Windows, where the pathname would be /C:/folder.
  return fileURLToPath(url);
}

interface Loaded { name: string; builtin: boolean; source?: SecretSource & { stop?(): void }; problem?: string }

/** One entry in its form, or the reason it cannot load. */
function loadEntry(entry: SourceEntry, options: RegistryOptions): Loaded {
  const loaded = { name: entry.name, builtin: false };
  try {
    const folder = originFolder(entry.origin);
    const settings = entry.settings ?? {};
    if (entry.form === 'stdio') {
      if (!Array.isArray(entry.command) || entry.command.length === 0 || !entry.command.every((w) => typeof w === 'string')) {
        throw new Error('a stdio source needs a command, the executable and its arguments');
      }
      return { ...loaded, source: stdioSource({ name: entry.name, folder, command: entry.command, settings, timeoutMs: options.timeoutMs, log: options.log }) };
    }
    if (entry.form === 'node' || entry.form === undefined) return { ...loaded, source: loadNodeSource(folder, settings) };
    throw new Error(`the form ${String(entry.form)} is not one version 1 runs; use node or stdio`);
  } catch (e) {
    return { ...loaded, problem: (e as Error).message };
  }
}

/** Wait for `work`, or fail with a sentence after `ms`. */
function within<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the source ${name} did not answer within ${Math.round(ms / 1000) || ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Only the metadata fields of a candidate, so a source that answers more never passes it on. */
function metadata(c: SourceCandidate, name: string): SourceCandidate {
  if (!c || typeof c.id !== 'string' || !c.id || typeof c.label !== 'string') throw new Error(`the source ${name} answered a candidate without an id and a label`);
  const out: SourceCandidate = { id: c.id, label: c.label };
  for (const k of ['store', 'type', 'host'] as const) if (typeof c[k] === 'string') out[k] = c[k];
  if (typeof c.changedAt === 'number') out.changedAt = c.changedAt;
  return out;
}

const hasField = (q: SecretQuery): boolean => [q.name, q.type, q.host].some((v) => typeof v === 'string' && v !== '');

/** The sources of this computer, as the inbox reaches them. `close` stops each stdio source's process. */
export function loadSecretSources(options: RegistryOptions): SecretSources & { close(): void } {
  const timeoutMs = options.timeoutMs ?? SOURCE_CALL_TIMEOUT_MS;
  const lines = readLines(options.home);
  const entries = lines.flatMap((l) => ('entry' in l ? [l.entry] : []));
  const builtins = options.builtins ?? BUILTINS;
  const loaded: Loaded[] = builtins.map((b) => {
    const settings = entries.find((e) => e.builtin && e.name === b.name)?.settings ?? {};
    try { return { name: b.name, builtin: true, source: b.create(settings, { home: options.home }) }; } catch (e) { return { name: b.name, builtin: true, problem: (e as Error).message }; }
  });
  for (const l of lines) {
    if ('problem' in l) { loaded.push({ name: `line ${l.line}`, builtin: false, problem: l.problem }); continue; }
    const { entry } = l;
    if (entry.builtin) {
      if (!builtins.some((b) => b.name === entry.name)) loaded.push({ name: entry.name, builtin: false, problem: `no built-in source is named ${entry.name}` });
      continue;
    }
    if (loaded.some((s) => s.name === entry.name)) { loaded.push({ name: entry.name, builtin: false, problem: `another source is already named ${entry.name}` }); continue; }
    loaded.push(loadEntry(entry, options));
  }

  const info = (s: Loaded, status: SourceInfo['status'], reason?: string): SourceInfo =>
    ({ instance: options.instance, name: s.name, builtin: s.builtin, status, ...(reason ? { reason } : {}) });

  /** Each source with its detected status. A source that throws or hangs reads as an error. */
  async function detectAll(): Promise<{ s: Loaded; detected: SourceInfo }[]> {
    return Promise.all(loaded.map(async (s) => {
      if (!s.source) return { s, detected: info(s, 'error', s.problem) };
      try {
        const d: Detected = await within(s.source.detect(), timeoutMs, s.name);
        if (d?.status === 'ready') return { s, detected: info(s, 'ready') };
        if (d?.status === 'off') return { s, detected: info(s, 'off', typeof d.reason === 'string' ? d.reason : 'the source is off') };
        return { s, detected: info(s, 'error', `the source ${s.name} answered detect with no status`) };
      } catch (e) {
        return { s, detected: info(s, 'error', (e as Error).message) };
      }
    }));
  }

  return {
    async list() {
      return (await detectAll()).map((d) => d.detected);
    },

    async lookup(query) {
      const detected = await detectAll();
      if (!hasField(query)) return { candidates: [], sources: detected.map((d) => d.detected) };
      const answers = await Promise.all(detected.map(async ({ s, detected: d }): Promise<{ d: SourceInfo; found: Candidate[] }> => {
        if (d.status !== 'ready' || !s.source) return { d, found: [] };
        try {
          const found = await within(s.source.lookup(query), timeoutMs, s.name);
          if (!Array.isArray(found)) throw new Error(`the source ${s.name} answered lookup without a list`);
          return { d, found: found.map((c) => ({ ...metadata(c, s.name), source: s.name, instance: options.instance })) };
        } catch (e) {
          return { d: info(s, 'error', (e as Error).message), found: [] };
        }
      }));
      return { candidates: answers.flatMap((a) => a.found), sources: answers.map((a) => a.d) };
    },

    async release(name, candidate, publicKey): Promise<Sealed> {
      const s = loaded.find((l) => l.name === name);
      if (!s) throw new Error(`There is no secret source named ${name} on ${options.instance}.`);
      if (!s.source) throw new Error(`The secret source ${name} did not load: ${s.problem}`);
      const sealed = await within(s.source.release(candidate, publicKey), timeoutMs, name);
      if (!isSealed(sealed)) throw new Error(`The secret source ${name} did not seal the value, so the inbox refuses it.`);
      return sealed;
    },

    close() {
      for (const s of loaded) s.source?.stop?.();
    },
  };
}
