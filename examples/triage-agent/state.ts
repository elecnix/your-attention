// What the example triage agent remembers between cards and across restarts: how many times it returned each card,
// and the bypass codes it gave out. It keeps them in one JSON file that only this user can read, since a bypass code
// lets a card skip triage. Without a file, it keeps them in memory, which the eval and the tests use.
//
// A card's attempts form a chain, and the chain counts the returns:
//   - a revision keeps its card id, so it stays in the chain of that id;
//   - a new card that `follows` a card in a chain joins that chain;
//   - a new card from the same agent with the same title as a chain seen in the last day joins that chain, since an
//     agent often posts its fix as a new card without `follows`.
// Anything else starts a chain of its own. Entries older than a week go when the file is next written.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const KEEP = 7 * DAY;

interface Chain { agent: string; title: string; returns: number; at: number }
interface Bypass { agent: string; card: string; issuedAt: number; usedAt?: number; usedOn?: string }
interface Stored { chains: Record<string, Chain>; cards: Record<string, { chain: string; at: number }>; bypass: Record<string, Bypass> }

export type BypassCheck = { ok: true; issuedFor: string } | { ok: false; why: string };

const normal = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, ' ');

export class TriageState {
  private data: Stored = { chains: {}, cards: {}, bypass: {} };
  /** Set when the file could not be read, so the agent can log that it started with an empty state. */
  readonly warning: string | undefined;
  private readonly file: string | undefined;
  private readonly now: () => number;

  constructor(file: string | undefined, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    let warning: string | undefined;
    if (file && fs.existsSync(file)) {
      try {
        const read = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Stored> | null;
        const table = (v: unknown): boolean => v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v));
        if (!read || typeof read !== 'object' || !table(read.chains) || !table(read.cards) || !table(read.bypass)) throw new Error('it is not a state file');
        // An entry of the wrong type goes, so its card counts from zero instead of breaking every check of it.
        const keep = <T>(rec: Record<string, unknown> | undefined, ok: (v: Record<string, unknown>) => boolean): Record<string, T> =>
          Object.fromEntries(Object.entries(rec ?? {}).filter(([, v]) => typeof v === 'object' && v !== null && ok(v as Record<string, unknown>))) as Record<string, T>;
        this.data = {
          chains: keep<Chain>(read.chains as Record<string, unknown> | undefined, (c) => typeof c['agent'] === 'string' && typeof c['title'] === 'string' && typeof c['returns'] === 'number' && typeof c['at'] === 'number'),
          cards: keep(read.cards as Record<string, unknown> | undefined, (c) => typeof c['chain'] === 'string' && typeof c['at'] === 'number'),
          bypass: keep<Bypass>(read.bypass as Record<string, unknown> | undefined, (b) => typeof b['agent'] === 'string' && typeof b['card'] === 'string' && typeof b['issuedAt'] === 'number'),
        };
      } catch (e) {
        // A file cut short by a crash loses its counts and codes, and the agent starts again from none.
        warning = `could not read ${file} (${(e as Error).message}), so the return counts and bypass codes start empty`;
      }
    }
    this.warning = warning;
  }

  /** The chain a card belongs to, recorded so its revisions and follow-ups find it. */
  chainOf(card: { id: string; agent: string; title: string; follows?: string }): string {
    const now = this.now();
    const known = this.data.cards[card.id]?.chain ?? (card.follows ? this.data.cards[card.follows]?.chain : undefined)
      ?? Object.entries(this.data.chains).find(([, c]) => c.agent === card.agent && c.title === normal(card.title) && now - c.at < DAY)?.[0];
    const chain = known ?? card.id;
    this.data.chains[chain] ??= { agent: card.agent, title: normal(card.title), returns: 0, at: now };
    // Seeing a card keeps its chain as fresh as its card entry, so a save never prunes one and keeps the other.
    this.data.chains[chain].at = now;
    this.data.cards[card.id] = { chain, at: now };
    return chain;
  }

  returns(chain: string): number {
    return this.data.chains[chain]?.returns ?? 0;
  }

  /** Count a return, and give the agent a new code that lets one of its cards skip triage once. */
  recordReturn(chain: string, card: { id: string; agent: string }): { returns: number; code: string } {
    const c = this.data.chains[chain];
    if (!c) throw new Error(`no chain ${chain}`);
    c.returns += 1;
    c.at = this.now();
    const code = `tb-${crypto.randomBytes(16).toString('base64url')}`;
    this.data.bypass[code] = { agent: card.agent, card: card.id, issuedAt: this.now() };
    this.save();
    return { returns: c.returns, code };
  }

  /** Use a bypass code: it works once, and only for the agent it went to. */
  useBypass(code: string, agent: string, card: string): BypassCheck {
    const b = this.data.bypass[code];
    if (!b) return { ok: false, why: 'triage never gave it' };
    if (b.agent !== agent) return { ok: false, why: 'it belongs to another agent' };
    if (b.usedAt !== undefined) return { ok: false, why: 'it was used already' };
    b.usedAt = this.now();
    b.usedOn = card;
    this.save();
    return { ok: true, issuedFor: b.card };
  }

  /** Save the cards seen since the last write, so a restart keeps every chain. */
  save(): void {
    if (!this.file) return;
    const cutoff = this.now() - KEEP;
    const drop = <T extends object>(rec: Record<string, T>, at: (v: T) => number): void => {
      for (const [k, v] of Object.entries(rec)) if (at(v) < cutoff) delete rec[k];
    };
    drop(this.data.chains, (c) => c.at);
    drop(this.data.cards, (c) => c.at);
    drop(this.data.bypass, (b) => b.usedAt ?? b.issuedAt);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
