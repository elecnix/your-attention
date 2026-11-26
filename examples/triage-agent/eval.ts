// A dry run of the example triage agent over the cards already in your inbox. It reads them as the owner, runs the
// four checks on each, and writes a Markdown report and the raw results as JSON. It sends no verdict, posts nothing
// and changes nothing in the inbox. Card text is private, so write the report outside any repository:
//   node examples/triage-agent/eval.ts --out ~/triage-eval/today.md [--since 2026-11-17] [--before TIME] [--config FILE]
// --before keeps the cards posted up to that time (a date alone is its local midnight), so a rerun can check the same cards as an earlier one.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client, ownerConfig } from '../../src/client.ts';
import type { Card } from '../../src/core/types.ts';
import { writePrivate } from '../../src/node/home.ts';
import { defaultConfigPath, loadConfig } from './checks.ts';
import { evaluate, parseWhen, renderReport } from './eval-report.ts';

const { values } = parseArgs({ options: { out: { type: 'string' }, since: { type: 'string' }, before: { type: 'string' }, config: { type: 'string' }, concurrency: { type: 'string', default: '3' } } });
const fail = (why: string): never => { console.error(why); process.exit(1); };
const out = values.out || fail('Give the report path with --out FILE, outside any repository: the report quotes card text.');
// A date alone means its midnight in local time, for both ends, and no --since means today's.
// An empty value, as from an unset shell variable, is an error, never the default.
const since = values.since !== undefined ? parseWhen(values.since) ?? fail(`--since must be a date or a time, such as 2026-11-17: ${values.since}`) : new Date(new Date().setHours(0, 0, 0, 0));
const until = values.before !== undefined ? parseWhen(values.before) ?? fail(`--before must be a date or a time, such as 2026-11-18: ${values.before}`) : new Date();
const owner = ownerConfig() ?? fail('This machine runs no inbox and is not paired as owner: run `your-attention pair <url> --role owner`.');
const cfg = loadConfig(values.config ?? defaultConfigPath());
// Make the report's folder before the run, so a long run never ends without a place to write.
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

// Every agent card posted in the window, read page by page as the owner: cleared cards too, and no system cards.
const client = new Client(owner);
const cards: Card[] = [];
let cursor: string | undefined;
do {
  const page = await client.list({ since: since.getTime(), limit: 100, ...(cursor ? { cursor } : {}) });
  cards.push(...page.results.map((r) => r.card).filter((c) => (c.kind === 'ask' || c.kind === 'secret') && c.createdAt >= since.getTime() && c.createdAt <= until.getTime()));
  cursor = page.nextCursor;
} while (cursor);
console.error(`${cards.length} cards since ${since.toISOString()}`);

/** OpenRouter's count of what the key in OPENROUTER_API_KEY spent, when the variable holds the key the checks use. */
async function usage(): Promise<number | undefined> {
  const key = process.env['OPENROUTER_API_KEY'];
  if (!key) return undefined;
  // A request that stalls leaves the spend unmeasured after 10 seconds instead of holding the eval open.
  const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  // A reply that isn't the key's JSON, such as a maintenance page, means the spend goes unmeasured.
  const data = res?.ok ? (await res.json().catch(() => undefined) as { data?: { usage?: number } } | undefined)?.data : undefined;
  return typeof data?.usage === 'number' ? data.usage : undefined;
}

const stop = new AbortController();
process.on('SIGINT', () => stop.abort());
const before = await usage();
const started = Date.now();
const results = await evaluate(cards, cfg, { concurrency: Number(values.concurrency) || 3, signal: stop.signal }).catch((e: Error) => fail(`Stopped: ${e.message}.`));
const ms = Date.now() - started;
// Once the checks are done, Ctrl-C ends the process as Node does by default, so it never writes the report it stopped.
process.removeAllListeners('SIGINT');
const after = await usage();
const spent = before !== undefined && after !== undefined ? after - before : undefined;
// writePrivate sets mode 0600 on a file that already exists too, since the report quotes card text.
writePrivate(out, renderReport(results, { since, ms, ...(spent === undefined ? {} : { usageUsd: spent }) }));
writePrivate(out.replace(/\.md$/, '') + '.json', JSON.stringify(results.map((r) => ({ id: r.card.id, title: r.card.title, ms: r.ms, blockedBy: r.blockedBy, advisedBy: r.advisedBy, reports: r.reports })), null, 1));
console.error(`wrote ${out}`);
