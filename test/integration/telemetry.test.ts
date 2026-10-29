// `your-attention telemetry`: the person reads, turns off and resets the usage counts of the inbox on this machine.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ROOT, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];
/** The inbox address, once server.json is complete. A read in the middle of the write waits for the next poll. */
const serverUrl = (file: string): { url: string } | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string }; } catch { return undefined; }
};
const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  promisify(execFile)(process.execPath, [...CLI, ...args], { env, encoding: 'utf8' }).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);

describe('usage counts from the command line', () => {
  it('starts off, offers the counts, and sends them only after the person turns them on', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-telemetry-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention'), YOUR_ATTENTION_TELEMETRY: '', DO_NOT_TRACK: '', YOUR_ATTENTION_TELEMETRY_URL: 'http://127.0.0.1:9/v1/report', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' };
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    try {
      const file = path.join(String(env['YOUR_ATTENTION_HOME']), 'server.json');
      const { url } = await until(() => serverUrl(file));
      const owner = fs.readFileSync(path.join(String(env['YOUR_ATTENTION_HOME']), 'owner-token'), 'utf8').trim();
      const agent = fs.readFileSync(path.join(String(env['YOUR_ATTENTION_HOME']), 'agent-token'), 'utf8').trim();
      const status = async () => (await (await fetch(`${url}/v1/telemetry`, { headers: { authorization: `Bearer ${owner}` } })).json()) as { enabled: boolean; notified: boolean; installId: string };
      const first = await status();
      assert.deepEqual([first.enabled, first.notified], [false, false], 'a laptop inbox starts off, and nobody was asked yet');

      const shown = await run(env, 'telemetry', 'status');
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, /Usage counts are off/);
      assert.match(shown.stdout, /anonymous/);
      assert.deepEqual([(await status()).enabled, (await status()).notified], [false, true], 'reading the offer turns nothing on');

      const post = (title: string) => fetch(`${url}/v1/cards`, { method: 'POST', headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'my-agent', title }) });
      await post('Counted while off?');
      assert.equal((JSON.parse((await run(env, 'telemetry', 'show')).stdout) as { counts: { cards: number } }).counts.cards, 0, 'an inbox that is off counts nothing');

      const on = await run(env, 'telemetry', 'on');
      assert.equal(on.code, 0, on.stderr);
      assert.match(on.stdout, /Usage counts are on/);
      assert.match(on.stdout, /127\.0\.0\.1:9/);
      await post('A private question');
      const show = await run(env, 'telemetry', 'show');
      assert.equal(show.code, 0, show.stderr);
      const next = JSON.parse(show.stdout) as { source: string; invite: string; counts: { cards: number } };
      assert.deepEqual([next.source, next.invite, next.counts.cards], ['laptop', '', 1]);
      assert.doesNotMatch(show.stdout, /private|my-agent|127\.0\.0\.1/);

      const before = (await status()).installId;
      assert.equal((await run(env, 'telemetry', 'reset-id')).code, 0);
      assert.notEqual((await status()).installId, before);

      const off = await run(env, 'telemetry', 'off');
      assert.equal(off.code, 0, off.stderr);
      assert.match(off.stdout, /off/);
      assert.equal((await status()).enabled, false);

      const report = await run(env, 'telemetry', 'report');
      assert.notEqual(report.code, 0);
      assert.match(report.stderr, /CLOUDFLARE_ACCOUNT_ID/);
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so when DO_NOT_TRACK keeps everything on this machine', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-telemetry-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention'), DO_NOT_TRACK: '1' };
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    try {
      const file = path.join(String(env['YOUR_ATTENTION_HOME']), 'server.json');
      await until(() => serverUrl(file));
      const shown = await run(env, 'telemetry', 'status');
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, /DO_NOT_TRACK/);
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('says no inbox runs when the inbox has stopped', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-telemetry-'));
    const ya = path.join(home, '.your-attention');
    fs.mkdirSync(ya, { recursive: true });
    // A stopped inbox can leave its address and token behind.
    fs.writeFileSync(path.join(ya, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:9', port: 9, pid: 1 }));
    fs.writeFileSync(path.join(ya, 'owner-token'), 'x');
    try {
      const r = await run({ ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: ya }, 'telemetry', 'status');
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /No inbox runs on this machine/);
      assert.doesNotMatch(r.stderr, /fetch failed|at /);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
