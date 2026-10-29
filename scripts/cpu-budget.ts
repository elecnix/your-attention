// Measures the CPU time of the hosted inbox's request paths on the largest inputs it accepts, against the 10 ms that the
// Workers Free plan gives each request. It runs the Durable Object's inbox, with its storage adapter on node:sqlite, and
// each path in a fresh process, so the first request pays for compiling the code as it would in a new isolate.
// Run it with `npm run cpu-budget`. It exits with 1 when the warm median of a path goes over the budget. The first request
// prints for information only: in Node it also compiles the JavaScript fetch classes, which workerd implements natively.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DurableSqlStorage } from '../src/cloudflare/storage.ts';
import { createHandler } from '../src/core/http.ts';
import { Inbox, MAX_CARD_BYTES } from '../src/core/inbox.ts';
import { newPinKey, pinKey } from '../src/core/pin.ts';
import { MAX_SHOWN_CARDS } from '../src/core/summary.ts';
import { MemoryBlobs } from '../src/core/storage.ts';
import { dataPoint } from '../src/core/telemetry.ts';

export const BUDGET_MS = 10;
/** Warm runs after the first request, to read the median. */
const RUNS = 15;

/** The Durable Object's SqlStorage, on node:sqlite. */
function durableStorage(): DurableSqlStorage {
  const db = new DatabaseSync(':memory:');
  return new DurableSqlStorage({ exec: (q, ...b) => { const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[]; return { toArray: () => rows }; } });
}

/** The inbox as src/cloudflare/inbox-object.ts builds it, with no storage limit so the setup can fill it. */
async function hosted() {
  const store = durableStorage();
  const inbox = new Inbox(store, Date.now, new MemoryBlobs(), { keepPresence: true, clientChecks: true, usageAlwaysOn: true });
  const handle = createHandler(inbox, { heartbeatMs: 2000, streams: false, telemetry: { source: 'hosted', destination: 'the operator', blocked: () => undefined } });
  const owner = (await inbox.createToken('owner', 'owner', { pinExempt: true })).secret;
  const agent = (await inbox.createToken('agents', 'agent')).secret;
  const call = (method: string, path: string, token: string, body?: unknown) =>
    handle(new Request(`https://inbox.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { inbox, store, call, owner, agent };
}

/** A body that draws whole, with a diagram the draw-fault report names, as large as a card at the limit can hold. */
const BIG_BODY = (() => {
  const lines = ['d = Mermaid("flowchart TD\\n  A --> B")'];
  const names = ['d'];
  // Each statement is about 120 bytes as JSON, and the root lists every name, so stop with room for the root and the other fields.
  for (let i = 0, size = 0; size < MAX_CARD_BYTES - 12_000; i++) {
    const line = `t${i} = TextContent(${JSON.stringify(`Line ${i}: ${'x'.repeat(100)}`)})`;
    lines.push(line);
    names.push(`t${i}`);
    size += JSON.stringify(line).length + `t${i}, `.length;
  }
  return [`root = Card([${names.join(', ')}])`, ...lines].join('\n');
})();

/** A card as large as the inbox takes. */
const maxCard = (id: string) => ({ id, agent: 'budget', title: `Card ${id}`, text: 'Pick one.\n\n```mermaid\nflowchart TD\n  A --> B\n```', body: BIG_BODY });

type Run = { prepare?: () => Promise<void>; run: () => Promise<Response> };
type Path = { name: string; setup: () => Promise<Run> };

const PATHS: Path[] = [
  { name: 'POST /v1/cards, a card at the 256 KB limit', setup: async () => {
    const h = await hosted();
    let n = 0;
    return { run: () => h.call('POST', '/v1/cards', h.agent, maxCard(`c${n++}`)) };
  } },
  { name: 'POST /v1/preview, the same card', setup: async () => {
    const h = await hosted();
    return { run: () => h.call('POST', '/v1/preview', h.agent, { card: maxCard('p') }) };
  } },
  { name: 'POST /v1/cards/<id>/draw-fault, on that card', setup: async () => {
    const h = await hosted();
    let n = 0;
    return {
      // Each report sends a fresh card back, so each run posts one first.
      prepare: async () => { await h.inbox.postCardWithFiles({ token: 'budget', role: 'agent' }, maxCard(`f${++n}`)); },
      run: () => h.call('POST', `/v1/cards/f${n}/draw-fault`, h.owner, { version: 1, renderer: '11.17.2', diagrams: [{ source: 'flowchart TD\n  A --> B', error: 'Parse error' }], body: ['`x` is used but never defined.'] }),
    };
  } },
  { name: 'POST /v1/unlock, a right key', setup: async () => {
    const h = await hosted();
    await h.inbox.pin.setKey(await newPinKey('2468'));
    const s = h.inbox.pin.status();
    const key = await pinKey('2468', s.salt ?? '', s.iterations);
    const link = (await h.inbox.createToken('link', 'owner')).secret;
    return { run: () => h.call('POST', '/v1/unlock', link, { key }) };
  } },
  { name: 'GET /v1/state, 20 MB of cards at the size limit', setup: async () => {
    const h = await hosted();
    for (let i = 0; h.store.bytes() < 20 * 1024 * 1024; i++) await h.inbox.postCardWithFiles({ token: 'budget', role: 'agent' }, maxCard(`s${i}`));
    return { run: () => h.call('GET', '/v1/state', h.owner) };
  } },
  { name: `GET /v1/state, ${MAX_SHOWN_CARDS} cards, the most it shows, each with the largest summary`, setup: async () => {
    const h = await hosted();
    const long = (n: number, i: number) => `${i} ${'w'.repeat(n)}`.slice(0, n);
    for (let i = 0; i < MAX_SHOWN_CARDS; i++) {
      const links = Array.from({ length: 20 }, (_, j) => `[[${long(78, i * 20 + j)}]]`).join(' ');
      h.inbox.postCard({ token: 'budget', role: 'agent' }, {
        id: `m${i}`, agent: `a${i % 50}`, title: long(300, i), text: `${links} ${'x'.repeat(4000)}`, status: long(200, i), from: long(80, i),
        tags: Object.fromEntries(Array.from({ length: 10 }, (_, j) => [long(100, j), long(100, i)])), origin: { name: long(200, i), harness: 'claude-code' },
        options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }],
      });
    }
    return { run: () => h.call('GET', '/v1/state', h.owner) };
  } },
  { name: 'GET /v1/cards/<id>, a card at the 256 KB limit', setup: async () => {
    const h = await hosted();
    await h.inbox.postCardWithFiles({ token: 'budget', role: 'agent' }, maxCard('big'));
    return { run: () => h.call('GET', '/v1/cards/big', h.owner) };
  } },
  { name: 'GET /v1/telemetry', setup: async () => {
    const h = await hosted();
    return { run: () => h.call('GET', '/v1/telemetry', h.owner) };
  } },
  { name: 'the daily usage report, a week of days with 1,000 distinct keys each', setup: async () => {
    let day = Date.UTC(2026, 9, 1);
    const inbox = new Inbox(durableStorage(), () => day, new MemoryBlobs(), { keepPresence: true, clientChecks: true, usageAlwaysOn: true });
    for (let d = 0; d < 7; d++, day += 86_400_000) {
      for (let i = 0; i < 1000; i++) { inbox.usage.saw('agents', `agent-${d}-${i}`); inbox.usage.saw('tokens', `token-${d}-${i}`); inbox.usage.saw('instances', `inst-${d}-${i}`); inbox.usage.saw('pages', `page-${d}-${i}`); }
      inbox.usage.record('cards');
    }
    // What InboxObject.sendUsage does at the next request after the days end.
    return { run: async () => {
      for (const d of inbox.usage.due()) { dataPoint(inbox.usage.report(d, 'hosted')); inbox.usage.done(d.day); }
      return new Response(null, { status: 204 });
    } };
  } },
];

/** CPU milliseconds of this process, every thread, across one request. */
async function cpu(run: () => Promise<Response>): Promise<number> {
  const start = process.cpuUsage();
  const res = await run();
  const body = await res.arrayBuffer();
  const d = process.cpuUsage(start);
  if (res.status >= 400) throw new Error(`the request answered ${res.status}: ${new TextDecoder().decode(body)}`);
  return (d.user + d.system) / 1000;
}

/** One path in this process: the first request, then the median of the warm ones. */
async function measure(path: Path): Promise<{ first: number; median: number }> {
  const { prepare, run } = await path.setup();
  const once = async () => { await prepare?.(); return cpu(run); };
  const first = await once();
  const warm: number[] = [];
  for (let i = 0; i < RUNS; i++) warm.push(await once());
  warm.sort((a, b) => a - b);
  return { first, median: warm[Math.floor(warm.length / 2)] ?? 0 };
}

if (process.argv[2] !== undefined) {
  const result = await measure(PATHS[Number(process.argv[2])]!);
  process.stdout.write(JSON.stringify(result));
} else {
  let over = false;
  console.log(`CPU time per request, budget ${BUDGET_MS} ms (Workers Free plan). First request in a fresh process, then the warm median of ${RUNS}.`);
  for (const [i, path] of PATHS.entries()) {
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', import.meta.filename, String(i)], { encoding: 'utf8' });
    if (child.status !== 0) { console.log(`${path.name}: failed\n${child.stderr}`); over = true; continue; }
    const { first, median } = JSON.parse(child.stdout) as { first: number; median: number };
    const fits = median <= BUDGET_MS;
    over ||= !fits;
    console.log(`${fits ? 'fits' : 'OVER'}  ${median.toFixed(2).padStart(7)} ms warm  ${first.toFixed(2).padStart(7)} ms first  ${path.name}`);
  }
  process.exitCode = over ? 1 : 0;
}
