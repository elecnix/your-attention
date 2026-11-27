// The stdio form of a secret source, against the example in examples/secret-source-stdio and a fixture that
// misbehaves on request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { loadSecretSources, writeSourceEntries } from '../../src/secrets/registry.ts';
import { stdioSource } from '../../src/secrets/stdio-source.ts';

const EXAMPLE = path.resolve('examples/secret-source-stdio');
const FIXTURE_DIR = path.resolve('test/integration');

describe('a stdio secret source', () => {
  const started: { stop(): void }[] = [];
  const source = (o: Partial<Parameters<typeof stdioSource>[0]> = {}): ReturnType<typeof stdioSource> => {
    const logs: string[] = [];
    const s = stdioSource({ name: 'fixture', folder: FIXTURE_DIR, command: ['node', 'stdio-source-fixture.ts'], log: (l) => logs.push(l), ...o });
    started.push(s);
    return s;
  };
  after(() => { for (const s of started) s.stop(); });

  it('looks up the example and releases a value the session key opens', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-stdio-'));
    writeSourceEntries(home, [{ kind: 'secret', name: 'example', form: 'stdio', origin: pathToFileURL(EXAMPLE).href, command: ['node', 'source.ts'] }]);
    const logs: string[] = [];
    const sources = loadSecretSources({ home, instance: 'laptop', builtins: [], log: (l) => logs.push(l) });
    assert.deepEqual(await sources.list(), [{ instance: 'laptop', name: 'example', builtin: false, status: 'ready' }]);
    const { candidates } = await sources.lookup({ type: 'api-key', host: 'api.example.com' });
    assert.deepEqual(candidates, [{ id: 'EXAMPLE_API_KEY', label: 'Example API key, made up', type: 'api-key', host: 'api.example.com', store: 'example', source: 'example', instance: 'laptop' }]);
    const keys = await newSealKeys();
    const sealed = await sources.release('example', 'EXAMPLE_API_KEY', keys.publicKey);
    assert.equal(await openSealed(keys.privateKey, sealed), 'ex-not-a-real-key-0000');
    await assert.rejects(sources.release('example', 'NOPE', keys.publicKey), /no secret named NOPE/);
    assert.ok(logs.includes('[example] example source started'), logs.join('\n'));
  });

  it('fails a call whose reply is not JSON, and starts the source again on the next call', async () => {
    const s = source();
    const [first] = await s.lookup({ name: 'WHO' });
    await assert.rejects(s.lookup({ name: 'GARBLE' }), /not JSON/);
    const [second] = await s.lookup({ name: 'WHO' });
    assert.notEqual(first?.label, second?.label, 'a new process answers after the fault');
  });

  it('fails a call whose reply gives another version', async () => {
    await assert.rejects(source().lookup({ name: 'V2' }), /version other than 1/);
  });

  it('fails a call that takes longer than its timeout, and starts again on the next call', async () => {
    const s = source({ timeoutMs: 200 });
    await assert.rejects(s.lookup({ name: 'HANG' }), /did not answer within/);
    assert.equal((await s.lookup({ name: 'WHO' })).length, 1);
  });

  it('fails a call when the source exits, and starts again on the next call', async () => {
    const s = source();
    await assert.rejects(s.lookup({ name: 'CRASH' }), /stopped \(exit 3\)/);
    assert.equal((await s.lookup({ name: 'WHO' })).length, 1);
  });

  it('refuses a release that answers a plain value', async () => {
    const keys = await newSealKeys();
    await assert.rejects(source().release('x', keys.publicKey), /without a sealed value/);
  });

  it('gives the source its settings in YOUR_ATTENTION_SOURCE_SETTINGS', async () => {
    const [c] = await source({ settings: { vault: 'Team' } }).lookup({ name: 'SETTINGS' });
    assert.deepEqual(JSON.parse(c?.label ?? ''), { vault: 'Team' });
  });

  it('says when its command cannot start', async () => {
    await assert.rejects(source({ command: ['./missing-source'] }).detect(), /could not start/);
  });
});
