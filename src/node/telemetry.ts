// Usage counts on a laptop: send each finished day to the collector, and read the
// counts back for the operator. src/core/telemetry.ts counts; this file only sends.
import { COUNTS, type Counts, type Usage } from '../core/telemetry.ts';

/** The collector the maintainers run: src/cloudflare/collector.ts, deployed as the "telemetry" Worker. */
export const DEFAULT_COLLECTOR = 'https://telemetry.your-attention.workers.dev/v1/report';
/** The Analytics Engine dataset that hosted inboxes and the collector write. */
export const DATASET = 'your_attention_usage';

export const NOTICE = `Your Attention sends one report a day of usage counts: how many cards were posted and answered,
pairing requests, page opens, and how many agents, agent processes and tokens connected. It never
sends card text, answers, agent names, paths, host names or addresses.
  your-attention telemetry show   prints the next report
  your-attention telemetry off    turns it off (DO_NOT_TRACK=1 does too)`;

export interface TelemetryEnv {
  url: string;
  /** Why this process sends nothing, such as DO_NOT_TRACK. */
  blocked?: string;
  /** Print each report to stderr instead of sending it. */
  debug?: boolean;
}

/** The setting from the environment: DO_NOT_TRACK=1 or YOUR_ATTENTION_TELEMETRY=off sends nothing, whatever the inbox says. */
export function telemetryEnv(env: Record<string, string | undefined> = process.env): TelemetryEnv {
  const off = (v: string | undefined): boolean => !!v && !['0', 'false', 'no', ''].includes(v.trim().toLowerCase());
  const blocked = off(env['DO_NOT_TRACK']) ? 'DO_NOT_TRACK is set'
    : ['off', '0', 'false', 'no'].includes((env['YOUR_ATTENTION_TELEMETRY'] ?? '').trim().toLowerCase()) ? 'YOUR_ATTENTION_TELEMETRY is off'
      : undefined;
  return { url: env['YOUR_ATTENTION_TELEMETRY_URL'] || DEFAULT_COLLECTOR, ...(blocked ? { blocked } : {}), ...(off(env['YOUR_ATTENTION_TELEMETRY_DEBUG']) ? { debug: true } : {}) };
}

/** Send each finished day, oldest first. A day goes out only when the person was told and left it on.
 * A day that cannot go out is forgotten. A day the collector did not take for a network or server error waits for the next try. */
export async function sendDue(usage: Usage, opts: TelemetryEnv & { fetch?: typeof fetch; log?: (line: string) => void }): Promise<void> {
  const send = opts.fetch ?? fetch;
  const log = opts.log ?? ((line: string) => console.error(`[your-attention] ${line}`));
  const s = usage.settings();
  for (const d of usage.due()) {
    if (!s.enabled || !s.notified || opts.blocked) { usage.done(d.day); continue; }
    const body = JSON.stringify(usage.report(d, 'laptop'));
    if (opts.debug) { log(`usage report, not sent: ${body}`); usage.done(d.day); continue; }
    try {
      const res = await send(opts.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
      if (res.status >= 500 || res.status === 429) return;
    } catch {
      return;
    }
    usage.done(d.day);
  }
}

/** The Analytics Engine SQL for one row per invite, inbox and day over the last `days` days. */
export function usageQuery(days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('days must be a whole number from 1 to 90');
  const sums = COUNTS.map((k, i) => `SUM(_sample_interval * double${i + 1}) AS ${k}`).join(', ');
  return `SELECT index1 AS invite, blob1 AS source, blob4 AS install, blob3 AS day, ${sums} FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY GROUP BY invite, source, install, day ORDER BY invite, day`;
}

export type UsageRow = { invite: string; source: string; install: string; day: string } & Counts;

export interface InviteSummary {
  /** The label from the invites file, or the invite id. */
  invite: string;
  inboxes: number;
  days: number;
  cards: number;
  answers: number;
  pairings: number;
  pages: number;
  peakAgents: number;
  peakInstances: number;
  peakTokens: number;
  /** Why the operator might look closer, or empty. */
  flag: string;
}

/** In one inbox and day, more agent processes or tokens than this is unusual for one person. */
export const MANY_INSTANCES = 30;
export const MANY_TOKENS = 10;
export const MANY_PAIRINGS = 20;

/** Sum the rows per invite. `labels` maps an invite id to the operator's own name for the code. */
export function summarize(rows: UsageRow[], labels: Map<string, string> = new Map()): InviteSummary[] {
  const by = new Map<string, UsageRow[]>();
  for (const r of rows) by.set(r.invite, [...(by.get(r.invite) ?? []), r]);
  return [...by.entries()].map(([invite, list]) => {
    const sum = (k: keyof Counts): number => list.reduce((n, r) => n + Number(r[k]), 0);
    const peak = (k: keyof Counts): number => Math.max(...list.map((r) => Number(r[k])));
    const flags = [
      peak('instances') > MANY_INSTANCES ? 'many clients' : '',
      peak('tokens') > MANY_TOKENS ? 'many tokens' : '',
      peak('pairings') > MANY_PAIRINGS ? 'many pairings' : '',
    ].filter(Boolean);
    return {
      invite: labels.get(invite) ?? invite,
      inboxes: new Set(list.map((r) => r.install)).size,
      days: new Set(list.map((r) => r.day)).size,
      cards: sum('cards'), answers: sum('answers'), pairings: sum('pairings'), pages: sum('pages'),
      peakAgents: peak('agents'), peakInstances: peak('instances'), peakTokens: peak('tokens'),
      flag: flags.join(', '),
    };
  }).sort((a, b) => b.cards - a.cards || a.invite.localeCompare(b.invite));
}

/** Run the query with the Analytics Engine SQL API. The token needs Account Analytics Read. */
export async function queryUsage(accountId: string, token: string, days: number, send: typeof fetch = fetch): Promise<UsageRow[]> {
  const res = await send(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: `${usageQuery(days)} FORMAT JSON`,
  });
  if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { data: UsageRow[] }).data;
}
