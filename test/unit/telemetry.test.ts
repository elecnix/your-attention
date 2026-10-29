import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { COUNTS, Usage, dataPoint, inviteId, parseReport, utcDay } from '../../src/core/telemetry.ts';
import { VERSION } from '../../src/core/version.ts';
import { sendDue, summarize, usageQuery } from '../../src/node/telemetry.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 28, 12);

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('usage counts', () => {
  it('counts the day in the inbox and keeps the sets on this machine', async () => {
    const c = clock();
    const store = new MemoryStorage();
    const inbox = new Inbox(store, c.now);
    inbox.usage.update({ enabled: true, notified: true });
    inbox.postCard({ token: 'ta', role: 'agent' }, { id: 'c1', agent: 'secret-agent-name', title: 'a private title' });
    inbox.postCard({ token: 'ta', role: 'agent' }, { id: 'c1', agent: 'secret-agent-name', title: 'a revision is not a new card' });
    await inbox.answer('c1', { comment: 'a private answer' });
    const stop = inbox.connect({ token: 'ta', role: 'agent' }, 'secret-agent-name', () => {}, 'proc-1');
    inbox.connect({ token: 'tb', role: 'agent' }, 'other-agent', () => {}, 'proc-2');
    inbox.connect({ token: 'ta', role: 'agent' }, 'secret-agent-name', () => {}, 'proc-1');
    stop();
    inbox.subscribePage(() => {}, 'viewer-1');
    inbox.subscribePage(() => {}, 'viewer-1');
    inbox.requestPairing('laptop', 'agent');
    const report = inbox.usage.report(inbox.usage.today(), 'laptop');
    assert.deepEqual(report.counts, { cards: 1, answers: 1, pairings: 1, pages: 1, agents: 2, instances: 2, tokens: 2 });
    assert.equal(report.day, '2026-10-28');
    assert.equal(report.version, VERSION);
    assert.match(report.installId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const sent = JSON.stringify(report);
    for (const secret of ['secret-agent-name', 'other-agent', 'private', 'proc-', 'viewer-', '"ta"', '"tb"', '"c1"']) assert.ok(!sent.includes(secret), `the report carries ${secret}`);
  });

  it('holds a finished day until the platform sends it, then forgets it', () => {
    const c = clock();
    const usage = new Usage(new MemoryStorage(), c.now);
    usage.update({ enabled: true });
    usage.record('cards');
    assert.deepEqual(usage.due(), []);
    c.advance(DAY);
    usage.record('cards');
    usage.record('cards');
    const due = usage.due();
    assert.equal(due.length, 1);
    assert.equal(due[0]?.day, '2026-10-28');
    assert.equal(due[0]?.counts.cards, 1);
    usage.done('2026-10-28');
    assert.deepEqual(usage.due(), []);
    assert.equal(usage.today().counts.cards, 2);
    c.advance(DAY);
    assert.equal(usage.due()[0]?.day, '2026-10-29', 'a day with no event after it still comes due');
  });

  it('keeps at most a week of unsent days', () => {
    const c = clock();
    const usage = new Usage(new MemoryStorage(), c.now);
    usage.update({ enabled: true });
    for (let i = 0; i < 10; i++) { usage.record('answers'); c.advance(DAY); }
    const due = usage.due();
    assert.equal(due.length, 7);
    assert.equal(due.at(-1)?.day, '2026-11-06');
  });

  it('counts nothing and forgets what it had once the person turns it off', () => {
    const c = clock();
    const usage = new Usage(new MemoryStorage(), c.now);
    usage.update({ enabled: true });
    usage.record('cards');
    c.advance(DAY);
    usage.record('cards');
    usage.update({ enabled: false });
    usage.record('cards');
    assert.deepEqual(usage.due(), []);
    assert.equal(usage.today().counts.cards, 0);
    c.advance(DAY);
    assert.deepEqual(usage.due(), []);
  });

  it('starts off on a laptop and counts nothing until the person turns it on', () => {
    const c = clock();
    const usage = new Usage(new MemoryStorage(), c.now);
    const first = usage.settings();
    assert.deepEqual([first.enabled, first.notified, first.alwaysOn], [false, false, false]);
    usage.record('cards');
    c.advance(DAY);
    assert.deepEqual(usage.due(), []);
    const next = usage.update({ resetId: true });
    assert.notEqual(next.installId, first.installId);
  });

  it('stays on in a hosted inbox, which has no off switch', () => {
    const c = clock();
    const usage = new Usage(new MemoryStorage(), c.now, { alwaysOn: true });
    assert.deepEqual([usage.settings().enabled, usage.settings().alwaysOn], [true, true]);
    usage.record('cards');
    assert.throws(() => usage.update({ enabled: false }), /always/);
    assert.equal(usage.settings().enabled, true);
    c.advance(DAY);
    assert.equal(usage.due().length, 1);
  });

  it('caps each set so one busy day cannot grow the inbox', () => {
    const usage = new Usage(new MemoryStorage(), clock().now, { alwaysOn: true });
    for (let i = 0; i < 2000; i++) usage.saw('instances', `p${i}`);
    assert.equal(usage.today().counts.instances, 1000);
  });

  it('turns an invite code into a stable id that does not reveal the code', async () => {
    const id = await inviteId('test-code-0123456789ab');
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(id, await inviteId('  test-code-0123456789ab '));
    assert.notEqual(id, await inviteId('test-code-0123456789ac'));
    assert.equal(utcDay(T0), '2026-10-28');
  });
});

describe('the report the collector accepts', () => {
  const good = { schema: 1, source: 'laptop', installId: '0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69', invite: '', version: '0.1.0', day: '2026-10-28', counts: { cards: 3, answers: 2, pairings: 0, pages: 1, agents: 2, instances: 2, tokens: 1 } };

  it('accepts the fixed fields and nothing else', () => {
    assert.deepEqual(parseReport(good, T0), good);
    const bad: [string, unknown][] = [
      ['an extra field', { ...good, cwd: '/home/me' }],
      ['an extra count', { ...good, counts: { ...good.counts, titles: 1 } }],
      ['text in a count', { ...good, counts: { ...good.counts, cards: 'many' } }],
      ['a negative count', { ...good, counts: { ...good.counts, cards: -1 } }],
      ['a huge count', { ...good, counts: { ...good.counts, cards: 1e9 } }],
      ['an install id that is not a uuid', { ...good, installId: 'my-laptop' }],
      ['a version with text', { ...good, version: '0.1.0 on my-laptop' }],
      ['a day in the future', { ...good, day: '2026-10-30' }],
      ['a day long past', { ...good, day: '2026-09-01' }],
      ['an unknown source', { ...good, source: 'phone' }],
      ['a raw invite code', { ...good, invite: 'test-code-0123456789ab' }],
    ];
    for (const [what, body] of bad) assert.equal(typeof parseReport(body, T0), 'string', what);
  });

  it('writes one Analytics Engine data point indexed by the invite id', () => {
    const point = dataPoint({ ...good, source: 'hosted', invite: '0123456789abcdef' } as never);
    assert.deepEqual(point.indexes, ['0123456789abcdef']);
    assert.deepEqual(point.blobs, ['hosted', '0.1.0', '2026-10-28', good.installId, '0123456789abcdef']);
    assert.deepEqual(point.doubles, COUNTS.map((k) => good.counts[k]));
    assert.deepEqual(dataPoint(good as never).indexes, ['laptop']);
  });

  it('keeps the version in step with package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});

describe('the telemetry routes', () => {
  async function setup(opts: { blocked?: string; hosted?: boolean } = {}) {
    const inbox = new Inbox(new MemoryStorage(), clock().now, undefined, { usageAlwaysOn: opts.hosted });
    const handle = createHandler(inbox, { telemetry: { source: opts.hosted ? 'hosted' : 'laptop', destination: 'https://collector.test/v1/report', blocked: () => opts.blocked } });
    const owner = (await inbox.createToken('page', 'owner')).secret;
    const agent = (await inbox.createToken('agents', 'agent')).secret;
    const call = (method: string, token: string, body?: unknown) => handle(new Request('http://inbox.test/v1/telemetry', { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { call, owner, agent };
  }

  it('offers the laptop owner to turn counts on, and lets only the owner change it', async () => {
    const { call, owner, agent } = await setup();
    assert.equal((await call('GET', agent)).status, 403);
    assert.equal((await call('PUT', agent, { enabled: true })).status, 403);
    const status = (await (await call('GET', owner)).json()) as { enabled: boolean; alwaysOn: boolean; notice: boolean; destination: string; next: { counts: object } };
    assert.deepEqual([status.enabled, status.alwaysOn, status.notice], [false, false, true], 'the page offers the counts once');
    assert.equal(status.destination, 'https://collector.test/v1/report');
    assert.deepEqual(Object.keys(status.next.counts), [...COUNTS]);
    const on = (await (await call('PUT', owner, { enabled: true })).json()) as { enabled: boolean; notified: boolean; notice: boolean };
    assert.deepEqual([on.enabled, on.notified, on.notice], [true, true, false]);
    assert.equal((await call('PUT', owner, { enabled: 'yes' })).status, 400);
  });

  it('tells the hosted owner the counts are always on, and refuses to turn them off', async () => {
    const { call, owner } = await setup({ hosted: true });
    const status = (await (await call('GET', owner)).json()) as { enabled: boolean; alwaysOn: boolean; notice: boolean };
    assert.deepEqual([status.enabled, status.alwaysOn, status.notice], [true, true, true]);
    assert.equal((await call('PUT', owner, { enabled: false })).status, 400);
    const seen = (await (await call('PUT', owner, { notified: true })).json()) as { enabled: boolean; notice: boolean };
    assert.deepEqual([seen.enabled, seen.notice], [true, false]);
  });

  it('shows no notice where nothing can be sent', async () => {
    const { call, owner } = await setup({ blocked: 'DO_NOT_TRACK is set' });
    const status = (await (await call('GET', owner)).json()) as { notice: boolean; blocked: string };
    assert.equal(status.notice, false);
    assert.equal(status.blocked, 'DO_NOT_TRACK is set');
  });
});

describe('the laptop sender', () => {
  /** A usage counter with one finished day. `chosen` says the person turned counts on themselves. */
  function due(chosen = false) {
    const c = clock();
    const usage = new Usage(new MemoryStorage(), c.now);
    usage.update({ enabled: true, notified: chosen });
    usage.record('cards');
    c.advance(DAY);
    return usage;
  }

  it('sends nothing on a laptop until the person chose to turn counts on, and drops the day', async () => {
    const usage = due();
    const sent: string[] = [];
    await sendDue(usage, { url: 'https://collector.test/v1/report', fetch: async (_u, init) => { sent.push(String(init?.body)); return new Response(null, { status: 204 }); } });
    assert.deepEqual(sent, []);
    assert.deepEqual(usage.due(), []);
  });

  it('sends a finished day once the person turned counts on, and keeps it when the collector is down', async () => {
    const usage = due(true);
    let up = false;
    const sent: unknown[] = [];
    const fetch = async (_u: string | URL | Request, init?: RequestInit) => {
      if (!up) throw new Error('offline');
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    };
    await sendDue(usage, { url: 'https://collector.test/v1/report', fetch });
    assert.equal(usage.due().length, 1, 'kept for the next try');
    up = true;
    await sendDue(usage, { url: 'https://collector.test/v1/report', fetch });
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { counts: { cards: number } }).counts.cards, 1);
    assert.deepEqual(usage.due(), []);
  });

  it('sends nothing when blocked, and prints the report instead in debug mode', async () => {
    for (const opts of [{ blocked: 'DO_NOT_TRACK is set' }, { debug: true }]) {
      const usage = due(true);
      const printed: string[] = [];
      let calls = 0;
      await sendDue(usage, { url: 'https://collector.test/v1/report', fetch: async () => { calls++; return new Response(null, { status: 204 }); }, log: (s) => printed.push(s), ...opts });
      assert.equal(calls, 0);
      assert.deepEqual(usage.due(), []);
      if (opts.debug) assert.match(printed.join('\n'), /"cards":1/);
    }
  });
});

describe('the operator report', () => {
  it('asks Analytics Engine for one row per invite, inbox and day', () => {
    const sql = usageQuery(30);
    assert.match(sql, /FROM your_attention_usage/);
    assert.match(sql, /INTERVAL '30' DAY/);
    assert.throws(() => usageQuery(Number.NaN));
  });

  it('sums each invite and flags an inbox with many clients in a day', () => {
    const rows = [
      { invite: 'aaaaaaaaaaaaaaaa', source: 'hosted', install: 'i1', day: '2026-10-27', cards: 4, answers: 3, pairings: 1, pages: 2, agents: 2, instances: 3, tokens: 2 },
      { invite: 'aaaaaaaaaaaaaaaa', source: 'hosted', install: 'i2', day: '2026-10-28', cards: 1, answers: 0, pairings: 0, pages: 1, agents: 1, instances: 40, tokens: 1 },
      { invite: 'laptop', source: 'laptop', install: 'i3', day: '2026-10-28', cards: 2, answers: 2, pairings: 0, pages: 1, agents: 1, instances: 1, tokens: 1 },
    ];
    const out = summarize(rows, new Map([['aaaaaaaaaaaaaaaa', 'alice']]));
    assert.deepEqual(out.map((r) => [r.invite, r.inboxes, r.days, r.cards, r.answers, r.peakInstances, r.flag]), [
      ['alice', 2, 2, 5, 3, 40, 'many clients'],
      ['laptop', 1, 1, 2, 2, 1, ''],
    ]);
  });
});
