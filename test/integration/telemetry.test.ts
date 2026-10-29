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
const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  promisify(execFile)(process.execPath, [...CLI, ...args], { env, encoding: 'utf8' }).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);

describe('usage counts from the command line', () => {
  it('tells the person, shows the next report, and turns off', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-telemetry-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention'), YOUR_ATTENTION_TELEMETRY: '', DO_NOT_TRACK: '', YOUR_ATTENTION_TELEMETRY_URL: 'http://127.0.0.1:9/v1/report', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' };
    const serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env, stdio: 'ignore' });
    try {
      const file = path.join(String(env['YOUR_ATTENTION_HOME']), 'server.json');
      const { url } = await until(() => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { url: string } : undefined));
      const owner = fs.readFileSync(path.join(String(env['YOUR_ATTENTION_HOME']), 'owner-token'), 'utf8').trim();
      const agent = fs.readFileSync(path.join(String(env['YOUR_ATTENTION_HOME']), 'agent-token'), 'utf8').trim();
      const status = async () => (await (await fetch(`${url}/v1/telemetry`, { headers: { authorization: `Bearer ${owner}` } })).json()) as { enabled: boolean; notified: boolean; installId: string };
      assert.equal((await status()).notified, false, 'a server without a terminal tells nobody, so it sends nothing yet');

      await fetch(`${url}/v1/cards`, { method: 'POST', headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'my-agent', title: 'A private question' }) });
      const shown = await run(env, 'telemetry', 'status');
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, /Usage counts are on/);
      assert.match(shown.stdout, /never/i);
      assert.match(shown.stdout, /127\.0\.0\.1:9/);
      assert.equal((await status()).notified, true);

      const show = await run(env, 'telemetry', 'show');
      assert.equal(show.code, 0, show.stderr);
      const next = JSON.parse(show.stdout) as { source: string; counts: { cards: number } };
      assert.equal(next.source, 'laptop');
      assert.equal(next.counts.cards, 1);
      assert.doesNotMatch(show.stdout, /private|my-agent/);

      const before = (await status()).installId;
      assert.equal((await run(env, 'telemetry', 'reset-id')).code, 0);
      assert.notEqual((await status()).installId, before);

      const off = await run(env, 'telemetry', 'off');
      assert.equal(off.code, 0, off.stderr);
      assert.match(off.stdout, /off/);
      assert.equal((await status()).enabled, false);
      assert.equal((await run(env, 'telemetry', 'on')).code, 0);
      assert.equal((await status()).enabled, true);

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
      await until(() => fs.existsSync(file));
      const shown = await run(env, 'telemetry', 'status');
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, /DO_NOT_TRACK/);
    } finally {
      serve.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
