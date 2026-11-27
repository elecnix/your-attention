// The node form of a secret source: a module this process imports from a folder on this computer, which exports the
// calls of SecretSource. SPEC.md#secret-sources holds the contract.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SecretSource } from './source.ts';

/** What the module exports. `setup` is optional, and receives the entry's settings once, before the first call. */
interface SourceModule extends Partial<SecretSource> {
  setup?(settings: Record<string, unknown>): unknown;
}

/** The file to import: the origin itself, or in a folder, its package.json `main`, or else its index file. */
export function moduleFile(origin: string): string {
  const stat = fs.statSync(origin, { throwIfNoEntry: false });
  if (!stat) throw new Error(`nothing is at ${origin}`);
  if (stat.isFile()) return origin;
  try {
    const main = (JSON.parse(fs.readFileSync(path.join(origin, 'package.json'), 'utf8')) as { main?: unknown }).main;
    if (typeof main === 'string' && main) return path.join(origin, main);
  } catch { /* no package.json, so the index file */ }
  const index = ['index.js', 'index.mjs', 'index.ts'].map((f) => path.join(origin, f)).find((f) => fs.existsSync(f));
  if (!index) throw new Error(`${origin} has no package.json with a main file, and no index.js`);
  return index;
}

/** A source that imports its module on the first call, so a broken module fails that call and not the whole list. */
export function loadNodeSource(origin: string, settings: Record<string, unknown>): SecretSource {
  const file = moduleFile(origin);
  let ready: Promise<SourceModule> | undefined;
  let failures = 0;
  const mod = (): Promise<SourceModule> => {
    ready ??= (async () => {
      // Node keeps a module that threw while it ran, and answers each later import of that address with the same error.
      // After a failure, a new query makes a new address, so Node reads the fixed file. The files it imports keep their
      // addresses, and Node offers no way to drop them, so a fix there needs a restart of the process.
      const url = pathToFileURL(file);
      if (failures > 0) url.search = `?attempt=${failures}`;
      const m = (await import(url.href)) as SourceModule;
      for (const call of ['detect', 'lookup', 'release'] as const) {
        if (typeof m[call] !== 'function') throw new Error(`${file} does not export ${call}`);
      }
      await m.setup?.(settings);
      return m;
    })();
    // A failed import is tried again on the next call, after the person fixes the module.
    ready.catch(() => { ready = undefined; failures++; });
    return ready;
  };
  return {
    detect: async () => (await mod()).detect!(),
    lookup: async (query) => (await mod()).lookup!(query),
    release: async (candidate, publicKey) => (await mod()).release!(candidate, publicKey),
  };
}
