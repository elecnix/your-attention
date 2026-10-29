// Usage counts: one report a day of how much an inbox was used, never what it holds.
// The inbox counts in its own storage. The platform sends each finished day: the laptop
// build posts it to the collector, and a hosted inbox writes it to Analytics Engine.
// A laptop inbox counts only after the person turns the counts on, and its reports carry a
// random install id only. A hosted inbox always counts, with its invite id, and says so.
import { sha256 } from './crypto.ts';
import type { Storage } from './storage.ts';
import { VERSION } from './version.ts';

/** Event counts and distinct counts, in the order of the data point's doubles. */
export const COUNTS = ['cards', 'answers', 'pairings', 'pages', 'agents', 'instances', 'tokens'] as const;
export type CountName = (typeof COUNTS)[number];
export type Counts = Record<CountName, number>;
/** Counted per event: new cards, saved answers, pairing requests. */
type EventName = 'cards' | 'answers' | 'pairings';
/** Counted as distinct keys: page ids, agent names, agent processes, tokens. The keys stay in the inbox; only their number leaves it. */
export type SetName = 'pages' | 'agents' | 'instances' | 'tokens';

export type Source = 'laptop' | 'hosted';

/** What leaves the inbox, once a day. */
export interface TelemetryReport {
  schema: 1;
  source: Source;
  /** A random UUID for this inbox, the only id a laptop report carries. `telemetry reset-id` replaces it. */
  installId: string;
  /** The invite id that created a hosted inbox, or empty on a laptop. */
  invite: string;
  version: string;
  /** The UTC day counted, as YYYY-MM-DD. */
  day: string;
  counts: Counts;
}

export interface TelemetrySettings {
  enabled: boolean;
  /** Whether the person has seen the notice: on a laptop, the offer to turn counts on. */
  notified: boolean;
  /** A hosted inbox has no off switch. */
  alwaysOn: boolean;
  installId: string;
  invite: string;
}

export interface DayCounts {
  day: string;
  counts: Counts;
}

interface Today {
  day: string;
  events: Record<EventName, number>;
  sets: Record<SetName, string[]>;
}

interface Stored extends Omit<TelemetrySettings, 'alwaysOn'> {
  today?: Today;
  pending: DayCounts[];
}

/** Days kept for a platform that could not send them, such as a laptop that was offline. */
const KEEP_DAYS = 7;
/** Distinct keys kept per set and day. The count stops there. */
const SET_CAP = 1000;
/** The largest count the collector accepts. */
export const MAX_COUNT = 10_000_000;
const KEY = 'telemetry';

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The id a hosted inbox reports for its invite code: the first 16 hex digits of the code's SHA-256.
 * Invite codes are at least 20 random characters, so the id does not give the code back. */
export async function inviteId(code: string): Promise<string> {
  return (await sha256(code.trim())).slice(0, 16);
}

const zero = (): Counts => ({ cards: 0, answers: 0, pairings: 0, pages: 0, agents: 0, instances: 0, tokens: 0 });

function countsOf(t: Today): Counts {
  return { ...zero(), ...t.events, pages: t.sets.pages.length, agents: t.sets.agents.length, instances: t.sets.instances.length, tokens: t.sets.tokens.length };
}

const fresh = (day: string): Today => ({ day, events: { cards: 0, answers: 0, pairings: 0 }, sets: { pages: [], agents: [], instances: [], tokens: [] } });

/** The usage counts of one inbox, kept in its storage. Calls are synchronous, like every other inbox change. */
export class Usage {
  private readonly store: Storage;
  private readonly now: () => number;
  private readonly alwaysOn: boolean;

  /** `alwaysOn` is for a hosted inbox, which counts whatever is stored. A laptop inbox starts off. */
  constructor(store: Storage, now: () => number = Date.now, opts: { alwaysOn?: boolean } = {}) {
    this.store = store;
    this.now = now;
    this.alwaysOn = opts.alwaysOn === true;
  }

  private load(): Stored {
    const s = this.store.get<Stored>('meta', KEY);
    if (s) return this.alwaysOn ? { ...s, enabled: true } : s;
    const created: Stored = { enabled: this.alwaysOn, notified: false, installId: crypto.randomUUID(), invite: '', pending: [] };
    this.store.put('meta', KEY, created);
    return created;
  }

  /** Move a finished day to the days waiting to be sent. */
  private roll(s: Stored): Stored {
    const day = utcDay(this.now());
    if (s.today && s.today.day !== day) {
      s.pending = [...s.pending, { day: s.today.day, counts: countsOf(s.today) }].slice(-KEEP_DAYS);
      s.today = undefined;
    }
    return s;
  }

  private change(f: (today: Today) => boolean): void {
    const s = this.load();
    if (!s.enabled) return;
    this.roll(s);
    s.today ??= fresh(utcDay(this.now()));
    if (f(s.today)) this.store.put('meta', KEY, s);
  }

  record(event: EventName): void {
    this.change((t) => { t.events[event] = Math.min(t.events[event] + 1, MAX_COUNT); return true; });
  }

  /** Count a distinct key, such as the id of an agent process: a key seen before today counts once. */
  saw(set: SetName, key: string): void {
    this.change((t) => {
      const list = t.sets[set];
      if (list.length >= SET_CAP || list.includes(key)) return false;
      list.push(key);
      return true;
    });
  }

  settings(): TelemetrySettings {
    const { enabled, notified, installId, invite } = this.load();
    return { enabled, notified, alwaysOn: this.alwaysOn, installId, invite };
  }

  /** Turning it off forgets every count not yet sent, so a day counted while on never goes out after the person said no. */
  update(patch: { enabled?: boolean; notified?: boolean; invite?: string; resetId?: boolean }): TelemetrySettings {
    if (this.alwaysOn && patch.enabled === false) throw new Error('a hosted inbox always sends usage counts');
    const s = this.load();
    if (patch.enabled !== undefined) s.enabled = patch.enabled;
    if (patch.notified !== undefined) s.notified = patch.notified;
    if (patch.invite !== undefined) s.invite = patch.invite;
    if (patch.resetId) s.installId = crypto.randomUUID();
    if (!s.enabled) { s.today = undefined; s.pending = []; }
    this.store.put('meta', KEY, s);
    return this.settings();
  }

  /** The counts so far today. */
  today(): DayCounts {
    const s = this.roll(this.load());
    const day = utcDay(this.now());
    return { day, counts: s.today ? countsOf(s.today) : zero() };
  }

  /** The finished days not yet sent, oldest first. */
  due(): DayCounts[] {
    const s = this.load();
    const before = s.pending.length;
    const had = s.today;
    this.roll(s);
    if (s.today !== had || s.pending.length !== before) this.store.put('meta', KEY, s);
    return s.pending;
  }

  /** Forget a day the platform sent, or chose not to send. */
  done(day: string): void {
    const s = this.load();
    s.pending = s.pending.filter((d) => d.day !== day);
    this.store.put('meta', KEY, s);
  }

  report(d: DayCounts, source: Source): TelemetryReport {
    const s = this.settings();
    return { schema: 1, source, installId: s.installId, invite: source === 'hosted' ? s.invite : '', version: VERSION, day: d.day, counts: { ...d.counts } };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Check a report against the fixed fields, for the collector. Returns the report, or why it was refused. */
export function parseReport(body: unknown, now: number): TelemetryReport | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the report must be an object';
  const r = body as Record<string, unknown>;
  const fields = ['schema', 'source', 'installId', 'invite', 'version', 'day', 'counts'];
  const extra = Object.keys(r).filter((k) => !fields.includes(k));
  if (extra.length) return `unknown field ${extra[0]}`;
  if (r['schema'] !== 1) return 'schema must be 1';
  if (r['source'] !== 'laptop' && r['source'] !== 'hosted') return 'source must be laptop or hosted';
  if (typeof r['installId'] !== 'string' || !UUID.test(r['installId'])) return 'installId must be a lowercase UUID';
  if (r['invite'] !== '' && !(typeof r['invite'] === 'string' && /^[0-9a-f]{16}$/.test(r['invite']))) return 'invite must be empty or 16 hex digits';
  if (typeof r['version'] !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(r['version'])) return 'version must be MAJOR.MINOR.PATCH';
  const day = r['day'];
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'day must be YYYY-MM-DD';
  const today = utcDay(now);
  if (day > today || day < utcDay(now - (KEEP_DAYS + 1) * 24 * 60 * 60 * 1000)) return 'day must be within the last week';
  const counts = r['counts'];
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return 'counts must be an object';
  const c = counts as Record<string, unknown>;
  const unknown = Object.keys(c).find((k) => !(COUNTS as readonly string[]).includes(k));
  if (unknown) return `unknown count ${unknown}`;
  const out = zero();
  for (const k of COUNTS) {
    const v = c[k] ?? 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) return `${k} must be a whole number from 0 to ${MAX_COUNT}`;
    out[k] = v;
  }
  return { schema: 1, source: r['source'], installId: r['installId'], invite: r['invite'], version: r['version'], day, counts: out };
}

/** The Analytics Engine data point for a report. The index is the invite id, or "laptop", so a query per invite reads one index. */
export function dataPoint(r: TelemetryReport): { indexes: string[]; blobs: string[]; doubles: number[] } {
  return { indexes: [r.invite || 'laptop'], blobs: [r.source, r.version, r.day, r.installId, r.invite], doubles: COUNTS.map((k) => r.counts[k]) };
}
