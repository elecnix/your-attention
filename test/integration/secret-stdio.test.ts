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

/** Whether the process `pid` ends within `ms`. */
async function ends(pid: number, ms: number): Promise<boolean> {
  const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + ms;
  while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !alive();
}

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
    started.push({ stop: () => fs.rmSync(home, { recursive: true, force: true }) });
    writeSourceEntries(home, [{ kind: 'secret', name: 'example', form: 'stdio', origin: pathToFileURL(EXAMPLE).href, command: ['node', 'source.ts'] }]);
    const logs: string[] = [];
    const sources = loadSecretSources({ home, instance: 'laptop', builtins: [], log: (l) => logs.push(l) });
    started.push({ stop: () => sources.close() });
    assert.deepEqual(await sources.list(), [{ instance: 'laptop', name: 'example', builtin: false, status: 'ready' }]);
    const { candidates } = await sources.lookup({ type: 'api-key', host: 'api.example.com' });
    assert.deepEqual(candidates, [{ id: 'EXAMPLE_API_KEY', label: 'Example API key, made up', type: 'api-key', host: 'api.example.com', store: 'example', source: 'example', instance: 'laptop' }]);
    const keys = await newSealKeys();
    const sealed = await sources.release('example', 'EXAMPLE_API_KEY', keys.publicKey);
    assert.equal(await openSealed(keys.privateKey, sealed), 'ex-not-a-real-key-0000');
    await assert.rejects(sources.release('example', 'NOPE', keys.publicKey), /no secret named NOPE/);
    // Names every object inherits are not secrets either.
    for (const inherited of ['__proto__', 'constructor', 'toString']) {
      await assert.rejects(sources.release('example', inherited, keys.publicKey), new RegExp(`no secret named ${inherited}`));
    }
    assert.ok(logs.includes('[example] example source started'), logs.join('\n'));
  });

  it('keeps the example answering after a line that is JSON but no request', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['source.ts'], { cwd: EXAMPLE, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stdin.write('null\n42\n');
    // The bad lines first, alone, so a crash they cause happens before the request below.
    await new Promise((r) => setTimeout(r, 1000));
    child.stdin.write('{"v":1,"id":"7","call":"detect"}\n');
    const deadline = Date.now() + 10_000;
    while (!out.includes('"id":"7"') && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.kill();
    assert.ok(out.includes('{"v":1,"id":"7","status":"ready"}'), `the example answered: ${out}`);
  });

  // Each fault fails the call, and a new process answers the next one.
  const faults: [what: string, query: string, error: RegExp][] = [
    ['a reply that is not JSON', 'GARBLE', /not JSON/],
    ['a reply that gives another version', 'V2', /version other than 1/],
    ['a call that takes longer than its timeout', 'HANG', /did not answer within/],
    ['an exit while a call waits', 'CRASH', /stopped \(exit 3\)/],
  ];
  for (const [what, query, error] of faults) {
    it(`fails ${what}, and starts the source again on the next call`, async () => {
      // A timeout long enough for a new Node process to start on a busy runner, so only the hanging call times out.
      const s = source({ timeoutMs: 3000 });
      const [first] = await s.lookup({ name: 'WHO' });
      await assert.rejects(s.lookup({ name: query }), error);
      const [second] = await s.lookup({ name: 'WHO' });
      assert.notEqual(first?.label, second?.label, 'a new process answers after the fault');
    });
  }

  it('kills a source that ignores SIGTERM after its timeout, so no copy outlives it', { skip: process.platform === 'win32' ? 'Windows has no SIGTERM to ignore' : false }, async () => {
    const s = source({ timeoutMs: 3000, killGraceMs: 200 });
    const [who] = await s.lookup({ name: 'WHO' });
    const pid = Number(who?.label);
    await assert.rejects(s.lookup({ name: 'STUBBORN' }), /did not answer within/);
    assert.ok(await ends(pid, 5000), `the source ${pid} still runs after SIGKILL`);
  });

  it('kills a source that ignores SIGTERM even when the process that started it has nothing else to do', { skip: process.platform === 'win32' ? 'Windows has no SIGTERM to ignore' : false }, async () => {
    // A short-lived process such as `your-attention secret source list`: it would end before an unref'd SIGKILL fires.
    const script = `
import { stdioSource } from ${JSON.stringify(pathToFileURL(path.resolve('src/secrets/stdio-source.ts')).href)};
const s = stdioSource({ name: 'fixture', folder: ${JSON.stringify(FIXTURE_DIR)}, command: ['node', 'stdio-source-fixture.ts'], timeoutMs: 1000, killGraceMs: 200, log: () => {} });
const [who] = await s.lookup({ name: 'WHO' });
console.log(who.label);
await s.lookup({ name: 'STUBBORN' }).catch(() => {});
`;
    const { execFileSync } = await import('node:child_process');
    const pid = Number(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 }).trim());
    const ended = await ends(pid, 3000);
    // The verdict comes first: killing a survivor here must not turn a failure into a pass.
    if (!ended) process.kill(pid, 'SIGKILL');
    assert.ok(ended, `the source ${pid} outlived the process that started it`);
  });

  it('keeps a reply the source wrote just before it exited', async () => {
    assert.deepEqual(await source().lookup({ name: 'LAST' }), [{ id: 'last', label: 'the last word' }]);
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

  it('lets the process that asked end at once when the command never started', async () => {
    // `secret source list` with a missing command: no source runs, so there is nothing to wait for before SIGKILL.
    const script = `
import { stdioSource } from ${JSON.stringify(pathToFileURL(path.resolve('src/secrets/stdio-source.ts')).href)};
const s = stdioSource({ name: 'missing', folder: ${JSON.stringify(FIXTURE_DIR)}, command: ['./missing-source'], killGraceMs: 8000, log: () => {} });
await s.detect().catch((e) => console.log(e.message));
console.log(Date.now());
`;
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 }).trim().split('\n');
    const ended = Date.now();
    assert.match(out[0] ?? '', /could not start/);
    const lingered = ended - Number(out[1]);
    assert.ok(lingered < 4000, `the process stayed ${lingered} ms after its last call, waiting on a kill timer`);
  });
});
