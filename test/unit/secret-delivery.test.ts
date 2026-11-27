// The session side of a secret_access grant: receive opens the sealed value into the grant store, the harness takes
// it for each command, and nothing reaches a file. SPEC.md#delivery-in-the-session holds the contract.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AccessGrant } from '../../src/core/secret-sources.ts';
import { newSealKeys, sealValue } from '../../src/core/sealed.ts';
import type { Answer, Card } from '../../src/core/types.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { Redactor } from '../../src/secrets/redact.ts';

const T0 = Date.UTC(2026, 10, 27, 12, 0);
const MIN = 60_000;
const VALUE = 'postgres://demo:not-a-real-password@db.invalid/app';

/** A session that posted card `id` asking for DATABASE_URL, and the access grant the inbox stores when the person grants it. */
async function granted(secrets: SecretRequests, id: string, until: number, extra: Partial<AccessGrant> = {}): Promise<{ card: Card; answer: Answer }> {
  const { publicKey, privateKey } = await newSealKeys();
  secrets.remember(id, privateKey);
  const card = { id, agent: 'pi:s1', title: 'Database?', secrets: ['DATABASE_URL'], createdAt: T0 } as unknown as Card;
  const value: AccessGrant = { grant: 'db', source: 'age', instance: 'laptop', until, case: `case-${id}`, sealed: await sealValue(publicKey, VALUE), ...extra };
  return { card, answer: { values: { DATABASE_URL: value }, answeredAt: T0 } as unknown as Answer };
}

describe('a secret_access grant in the session', () => {
  it('tells the model the name, the case id and both deadlines, and never the value or a path', async () => {
    const secrets = new SecretRequests(() => T0);
    const { card, answer } = await granted(secrets, 'c1', T0 + 60 * MIN);
    const text = await secrets.receive(card, answer);
    assert.match(text, /DATABASE_URL is available to this session until 2026-11-27 13:00 UTC/);
    assert.match(text, /after 15 min unused \(case case-c1\)/);
    assert.match(text, /\$DATABASE_URL/);
    assert.doesNotMatch(text, /not-a-real-password/);
    assert.doesNotMatch(text, /\//, 'no path');
  });

  it('ends on the idle window when nothing uses it, and a use restarts that window', async () => {
    let now = T0;
    const secrets = new SecretRequests(() => now);
    const { card, answer } = await granted(secrets, 'c2', T0 + 4 * 60 * MIN);
    await secrets.receive(card, answer);
    now += 14 * MIN;
    assert.deepEqual(secrets.env('pi:s1'), { DATABASE_URL: VALUE }, 'used at 14 minutes');
    now += 14 * MIN;
    assert.deepEqual(secrets.env('pi:s1'), { DATABASE_URL: VALUE }, 'the use restarted the window');
    now += 15 * MIN;
    assert.deepEqual(secrets.env('pi:s1'), {}, '15 minutes unused');
  });

  it('ends at the ceiling from the card, however often it is used', async () => {
    let now = T0;
    const secrets = new SecretRequests(() => now);
    const { card, answer } = await granted(secrets, 'c3', T0 + 30 * MIN);
    await secrets.receive(card, answer);
    for (let i = 0; i < 5; i++) {
      now += 5 * MIN;
      assert.deepEqual(secrets.env('pi:s1'), { DATABASE_URL: VALUE });
    }
    now += 5 * MIN;
    assert.equal(now, T0 + 30 * MIN);
    assert.deepEqual(secrets.env('pi:s1'), {}, 'used a moment before, and dead at the ceiling all the same');
    assert.equal(secrets.holds('pi:s1'), false);
  });

  it('ends on a revoke, at the next command rather than at the next expiry', async () => {
    const secrets = new SecretRequests(() => T0);
    const { card, answer } = await granted(secrets, 'c4', T0 + 60 * MIN);
    await secrets.receive(card, answer);
    assert.deepEqual(secrets.env('pi:s1'), { DATABASE_URL: VALUE });
    assert.equal(secrets.revoke('case-c4'), true);
    assert.deepEqual(secrets.env('pi:s1'), {});
    assert.equal(secrets.revoke('case-c4'), false, 'a case id ends once');
    assert.equal(secrets.mask(`url=${VALUE}`), 'url=[secret DATABASE_URL]', 'the value stays masked after the grant ends');
  });

  it('ignores a revoke for a grant this session does not hold, such as one the inbox kept across a restart', async () => {
    const secrets = new SecretRequests(() => T0);
    assert.equal(secrets.revoke('case-from-before'), false, 'a session with no grants');
    const { card, answer } = await granted(secrets, 'c9', T0 + 60 * MIN);
    await secrets.receive(card, answer);
    assert.equal(secrets.revoke('case-of-another-session'), false);
    assert.deepEqual(secrets.env('pi:s1'), { DATABASE_URL: VALUE }, 'the live grant is untouched');
  });

  it('holds no grant for a declined field, and says so', async () => {
    const secrets = new SecretRequests(() => T0);
    const card = { id: 'c5', agent: 'pi:s1', title: 'Database?', secrets: ['DATABASE_URL'], createdAt: T0 } as unknown as Card;
    const text = await secrets.receive(card, { values: { DATABASE_URL: { decline: true } }, answeredAt: T0 } as unknown as Answer);
    assert.match(text, /declined access to DATABASE_URL on card c5/);
    assert.deepEqual(secrets.env('pi:s1'), {});
    assert.equal(secrets.received, false);
  });

  it('holds no grant for a field the inbox already marked revoked', async () => {
    const secrets = new SecretRequests(() => T0);
    const { card, answer } = await granted(secrets, 'c6', T0 + 60 * MIN, { revokedAt: T0 });
    assert.match(await secrets.receive(card, answer), /revoked DATABASE_URL on card c6 \(case case-c6\)/);
    assert.deepEqual(secrets.env('pi:s1'), {});
  });

  it('grants one field and not another on the same card', async () => {
    const secrets = new SecretRequests(() => T0);
    const { card, answer } = await granted(secrets, 'c7', T0 + 60 * MIN);
    const both = { ...card, secrets: ['DATABASE_URL', 'OPENAI_KEY'] } as Card;
    const text = await secrets.receive(both, { ...answer, values: { ...answer.values, OPENAI_KEY: { decline: true } } });
    assert.match(text, /case case-c7/);
    assert.match(text, /declined access to OPENAI_KEY/);
    assert.deepEqual(Object.keys(secrets.env('pi:s1')), ['DATABASE_URL']);
  });

  it('leaves the home directory and the temp directory as they were after a command used the grant', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-delivery-'));
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(path.join(home, '.your-attention'), { recursive: true });
    fs.mkdirSync(tmp);
    const saved = { HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'], YOUR_ATTENTION_HOME: process.env['YOUR_ATTENTION_HOME'] };
    Object.assign(process.env, { HOME: home, TMPDIR: tmp, YOUR_ATTENTION_HOME: path.join(home, '.your-attention') });
    try {
      const before = snapshot(root);
      const secrets = new SecretRequests(() => T0);
      const { card, answer } = await granted(secrets, 'c8', T0 + 60 * MIN);
      await secrets.receive(card, answer);
      // A command started with the grant in its environment, as the harness starts it.
      const out = execFileSync('/bin/sh', ['-c', 'printf %s "$DATABASE_URL" | wc -c'], { env: { ...process.env, ...secrets.env('pi:s1') }, cwd: home }).toString().trim();
      assert.equal(Number(out), VALUE.length);
      assert.equal(process.env['DATABASE_URL'], undefined, 'the value never enters this process environment');
      assert.deepEqual(snapshot(root), before);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('masking a value in output', () => {
  it('masks a value split across any two chunks of a stream', () => {
    const r = new Redactor();
    r.add('TOKEN', 'abcdef123');
    const text = 'start abcdef123 middle abcdef123 end';
    for (let cut = 0; cut <= text.length; cut++) {
      const s = r.stream();
      assert.equal(s.push(text.slice(0, cut)) + s.push(text.slice(cut)) + s.end(), 'start [secret TOKEN] middle [secret TOKEN] end', `cut at ${cut}`);
    }
  });

  it('masks a longer value whole when it contains a shorter one, and leaves a value under four characters alone', () => {
    const r = new Redactor();
    r.add('SHORT', 'secret1');
    r.add('LONG', 'xx-secret1-yy');
    r.add('TINY', 'abc');
    assert.equal(r.mask('xx-secret1-yy secret1 abc'), '[secret LONG] [secret SHORT] abc');
  });

  it('masks every string of a tool result and keeps its shape', () => {
    const r = new Redactor();
    r.add('K', 'value-not-real');
    assert.deepEqual(r.maskDeep({ stdout: 'k=value-not-real', n: 1, list: ['value-not-real'] }), { stdout: 'k=[secret K]', n: 1, list: ['[secret K]'] });
  });
});

/** Every path under `dir` with its size and modification time. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs}`);
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}
