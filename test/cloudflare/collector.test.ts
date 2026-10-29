// The usage collector: the small Worker that takes laptop reports and writes them to Analytics Engine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import collector from '../../src/cloudflare/collector.ts';
import { utcDay } from '../../src/core/telemetry.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function env(limit = true) {
  const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
  const keys: string[] = [];
  return {
    points,
    keys,
    env: { USAGE: { writeDataPoint: (p: never) => { points.push(p); } }, LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: limit }; } } },
  };
}

const report = () => ({ schema: 1, source: 'laptop', installId: '0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69', invite: '', version: '0.1.0', day: utcDay(Date.now() - 24 * 60 * 60 * 1000), counts: { cards: 3, answers: 2 } });
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('https://telemetry.test/v1/report', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.7', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('the usage collector', () => {
  it('stores a laptop report as one data point, without the sender address', async () => {
    const e = env();
    const res = await collector.fetch(post(report()), e.env as never);
    assert.equal(res.status, 204);
    assert.equal(e.points.length, 1);
    assert.deepEqual(e.points[0]?.indexes, ['laptop']);
    assert.deepEqual(e.points[0]?.doubles, [3, 2, 0, 0, 0, 0, 0]);
    assert.doesNotMatch(JSON.stringify(e.points), /203\.0\.113/);
  });

  it('refuses a report that does not match, a claimed invite, a large body, and a sender over its limit', async () => {
    const e = env();
    assert.equal((await collector.fetch(post({ ...report(), path: '/home/me' }), e.env as never)).status, 400);
    assert.equal((await collector.fetch(post({ ...report(), source: 'hosted', invite: '0123456789abcdef' }), e.env as never)).status, 400, 'only a hosted inbox reports an invite, and it writes directly');
    assert.equal((await collector.fetch(post('{'), e.env as never)).status, 400);
    assert.equal((await collector.fetch(post('x'.repeat(5000)), e.env as never)).status, 413);
    assert.equal(e.points.length, 0);
    const limited = env(false);
    assert.equal((await collector.fetch(post(report()), limited.env as never)).status, 429);
    assert.equal(limited.points.length, 0);
  });

  it('answers a health check and nothing else', async () => {
    const e = env();
    assert.equal((await collector.fetch(new Request('https://telemetry.test/v1/health'), e.env as never)).status, 200);
    assert.equal((await collector.fetch(new Request('https://telemetry.test/v1/report'), e.env as never)).status, 404);
  });

  it('builds with wrangler', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-collector-'));
    const wrangler = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
    const r = spawnSync(wrangler, ['deploy', '--dry-run', '-c', 'wrangler.telemetry.jsonc', '--outdir', out], { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, encoding: 'utf8', shell: process.platform === 'win32' });
    fs.rmSync(out, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
  });
});
