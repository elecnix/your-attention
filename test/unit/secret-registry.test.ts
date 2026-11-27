// The registry of secret sources: what it reads from sources.jsonl, the order it merges candidates in, and how a
// source that fails or hangs leaves the others answering. SPEC.md#secret-sources holds the contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { newSealKeys, openSealed, sealValue } from '../../src/core/sealed.ts';
import type { SourceCandidate } from '../../src/core/secret-sources.ts';
import { loadSecretSources, readSourceEntries, writeSourceEntries, type Builtin } from '../../src/secrets/registry.ts';
import type { SecretSource } from '../../src/secrets/source.ts';

/** Every folder the tests make, removed after the last one. */
const made: string[] = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
const scratchHome = (): string => scratch('ya-registry-');

/** A source with made-up values, which answers whatever the query names. */
function standIn(values: Record<string, string>, extra: Partial<SecretSource> = {}): SecretSource {
  return {
    detect: async () => ({ status: 'ready' }),
    lookup: async (q) => Object.keys(values).filter((id) => id === q.name).map((id): SourceCandidate => ({ id, label: `${id}, made up` })),
    release: async (id, publicKey) => {
      const value = values[id];
      if (value === undefined) throw new Error(`no ${id} here`);
      return sealValue(publicKey, value);
    },
    ...extra,
  };
}

const builtin = (name: string, source: SecretSource): Builtin => ({ name, create: () => source });

describe('the secret source registry', () => {
  it('merges candidates in source order, and names the source and the instance of each', async () => {
    const home = scratchHome();
    const sources = loadSecretSources({
      home,
      instance: 'laptop',
      builtins: [builtin('first', standIn({ TOKEN: 'one' })), builtin('second', standIn({ TOKEN: 'two', OTHER: 'x' }))],
    });
    const { candidates, sources: listed } = await sources.lookup({ name: 'TOKEN' });
    assert.deepEqual(candidates.map((c) => [c.source, c.instance, c.id]), [['first', 'laptop', 'TOKEN'], ['second', 'laptop', 'TOKEN']]);
    assert.deepEqual(listed.map((s) => [s.name, s.status, s.builtin]), [['first', 'ready', true], ['second', 'ready', true]]);
  });

  it('answers no candidate to a query without any field, and asks no source', async () => {
    let asked = 0;
    const sources = loadSecretSources({
      home: scratchHome(),
      instance: 'laptop',
      builtins: [builtin('one', standIn({}, { lookup: async () => { asked++; return [{ id: 'all', label: 'everything' }]; } }))],
    });
    assert.deepEqual((await sources.lookup({})).candidates, []);
    assert.equal(asked, 0);
  });

  it('reports a failing source with its reason, and the others still answer', async () => {
    const sources = loadSecretSources({
      home: scratchHome(),
      instance: 'laptop',
      builtins: [
        builtin('broken', standIn({}, { lookup: async () => { throw new Error('the vault is locked'); } })),
        builtin('fine', standIn({ TOKEN: 'v' })),
      ],
    });
    const { candidates, sources: listed } = await sources.lookup({ name: 'TOKEN' });
    assert.deepEqual(candidates.map((c) => c.source), ['fine']);
    assert.deepEqual(listed.find((s) => s.name === 'broken'), { instance: 'laptop', name: 'broken', builtin: true, status: 'error', reason: 'the vault is locked' });
  });

  it('reports a source that does not answer in time as an error, and the others still answer', async () => {
    const sources = loadSecretSources({
      home: scratchHome(),
      instance: 'laptop',
      timeoutMs: 50,
      builtins: [
        builtin('slow', standIn({}, { lookup: () => new Promise(() => {}) })),
        builtin('fine', standIn({ TOKEN: 'v' })),
      ],
    });
    const started = Date.now();
    const { candidates, sources: listed } = await sources.lookup({ name: 'TOKEN' });
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(candidates.map((c) => c.source), ['fine']);
    const slow = listed.find((s) => s.name === 'slow');
    assert.equal(slow?.status, 'error');
    assert.match(slow?.reason ?? '', /did not answer within/);
  });

  it('asks only the sources that are ready, and says why another is off', async () => {
    let asked = 0;
    const sources = loadSecretSources({
      home: scratchHome(),
      instance: 'laptop',
      builtins: [builtin('off', standIn({}, { detect: async () => ({ status: 'off', reason: 'no identity file' }), lookup: async () => { asked++; return []; } }))],
    });
    const { sources: listed } = await sources.lookup({ name: 'TOKEN' });
    assert.equal(asked, 0);
    assert.deepEqual(listed, [{ instance: 'laptop', name: 'off', builtin: true, status: 'off', reason: 'no identity file' }]);
    assert.deepEqual(await sources.list(), listed);
  });

  it('keeps only the metadata fields of a candidate', async () => {
    const leaky = standIn({}, { lookup: async () => [{ id: 'k', label: 'K', type: 'api-key', value: 'plain' } as SourceCandidate] });
    const sources = loadSecretSources({ home: scratchHome(), instance: 'laptop', builtins: [builtin('leaky', leaky)] });
    const { candidates } = await sources.lookup({ name: 'k' });
    assert.deepEqual(candidates, [{ id: 'k', label: 'K', type: 'api-key', source: 'leaky', instance: 'laptop' }]);
  });

  it('releases a value sealed to the public key, from the named source', async () => {
    const keys = await newSealKeys();
    const sources = loadSecretSources({ home: scratchHome(), instance: 'laptop', builtins: [builtin('a', standIn({ TOKEN: 'from a' })), builtin('b', standIn({ TOKEN: 'from b' }))] });
    assert.equal(await openSealed(keys.privateKey, await sources.release('b', 'TOKEN', keys.publicKey)), 'from b');
  });

  it('refuses to release from a source it does not know, or a reply that is not sealed', async () => {
    const keys = await newSealKeys();
    const plain = standIn({}, { release: async () => ({ value: 'plain' }) as never });
    const sources = loadSecretSources({ home: scratchHome(), instance: 'laptop', builtins: [builtin('plain', plain)] });
    await assert.rejects(sources.release('nowhere', 'TOKEN', keys.publicKey), /no secret source named nowhere/);
    await assert.rejects(sources.release('plain', 'TOKEN', keys.publicKey), /did not seal/);
  });

  it('passes a built-in source the settings of its entry', async () => {
    const home = scratchHome();
    writeSourceEntries(home, [{ kind: 'secret', name: 'conf', builtin: true, settings: { dirs: ['/made/up'] } }]);
    let seen: unknown;
    loadSecretSources({ home, instance: 'laptop', builtins: [{ name: 'conf', create: (settings) => { seen = settings; return standIn({}); } }] });
    assert.deepEqual(seen, { dirs: ['/made/up'] });
  });

  it('lists an entry it cannot load as an error with the reason, after the built-in sources', async () => {
    const home = scratchHome();
    fs.writeFileSync(path.join(home, 'sources.jsonl'), [
      JSON.stringify({ kind: 'secret', name: 'remote', form: 'stdio', origin: 'https://example.com/source', command: ['run'] }),
      'not json',
      JSON.stringify({ kind: 'secret', name: 'nocommand', form: 'stdio', origin: 'file:///made/up' }),
    ].join('\n'));
    const sources = loadSecretSources({ home, instance: 'laptop', builtins: [builtin('first', standIn({}))] });
    const listed = await sources.list();
    assert.deepEqual(listed.map((s) => [s.name, s.status]), [['first', 'ready'], ['remote', 'error'], ['line 2', 'error'], ['nocommand', 'error']]);
    assert.match(listed[1]?.reason ?? '', /file:\/\//);
    assert.match(listed[2]?.reason ?? '', /not JSON/);
    assert.match(listed[3]?.reason ?? '', /command/);
  });

  it('loads a node module source from its file:// origin', async () => {
    const home = scratchHome();
    const dir = scratch('ya-node-source-');
    const sealed = path.resolve('src/core/sealed.ts');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', main: 'source.mjs' }));
    fs.writeFileSync(path.join(dir, 'source.mjs'), `
import { sealValue } from ${JSON.stringify(pathToFileURL(sealed).href)};
let vault = 'none';
export function setup(settings) { vault = settings.vault; }
export async function detect() { return { status: 'ready' }; }
export async function lookup(q) { return q.name === 'TOKEN' ? [{ id: 'token', label: 'Token in ' + vault }] : []; }
export async function release(id, publicKey) { return sealValue(publicKey, 'node value'); }
`);
    writeSourceEntries(home, [{ kind: 'secret', name: 'team', form: 'node', origin: pathToFileURL(dir).href, settings: { vault: 'Team' } }]);
    const sources = loadSecretSources({ home, instance: 'laptop', builtins: [] });
    const { candidates } = await sources.lookup({ name: 'TOKEN' });
    assert.deepEqual(candidates, [{ id: 'token', label: 'Token in Team', source: 'team', instance: 'laptop' }]);
    const keys = await newSealKeys();
    assert.equal(await openSealed(keys.privateKey, await sources.release('team', 'token', keys.publicKey)), 'node value');
  });

  it('reads back the entries it wrote', () => {
    const home = scratchHome();
    const entries = [{ kind: 'secret' as const, name: 'dev', form: 'stdio' as const, origin: 'file:///made/up', command: ['bin/source'] }];
    writeSourceEntries(home, entries);
    assert.deepEqual(readSourceEntries(home), entries);
    // Windows has no POSIX modes: there the file inherits the home folder's access list.
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'sources.jsonl')).mode & 0o777, 0o600);
  });
});
