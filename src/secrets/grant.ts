// A secret the person approved for one agent, held in this process and nowhere else, for as long as the approval
// lasts. Two clocks decide when it dies: an idle window that each use restarts, and an absolute ceiling chosen on
// the card. No use can push the ceiling later, which is what makes "until 18:30" mean 18:30 rather than "18:30 as
// long as something keeps touching it" (gpg-agent's documented contract, and the reason a pinentry cache expires
// even when it is used every minute).
//
// Nothing here writes the value anywhere: a grant lives in memory, and the caller hands it to the environment of a
// command it is about to spawn. A grant nobody takes dies on its idle window, which is the difference between a
// forgotten approval and a session-long one.
import { randomId } from '../core/crypto.ts';

/** Fifteen minutes idle is long enough to read a doc between two commands, short enough that a forgotten tab dies. */
export const DEFAULT_IDLE_MS = 15 * 60_000;

/** A day is the ceiling the requester cannot exceed, whatever the card asks for. */
export const MAX_UNTIL_MS = 24 * 60 * 60_000;

export interface Grant {
  name: string;
  agent: string;
  value: string;
  /** Absolute deadline in epoch ms. `take` never moves it. */
  until: number;
  /** Inactivity window in ms; each `take` restarts it. */
  idleMs: number;
  /** When this grant was last taken, or approved when it never was. */
  usedAt: number;
  /** A short handle for this approval, meant to be copied into a message or a log line. */
  caseId: string;
}

export interface HoldOptions {
  name: string;
  agent: string;
  value: string;
  /** Epoch ms after which the grant is dead whatever happens. Clamped to `MAX_UNTIL_MS` from now. */
  until: number;
  idleMs?: number;
  now?: number;
  /** The case id the inbox gave this approval, which the person sees on the card. A new one when absent. */
  caseId?: string;
}

const key = (agent: string, name: string): string => `${agent}\u0000${name}`;

export class Grants {
  /** Keyed by agent and name: two agents may hold the same secret, each on its own approval. */
  private readonly held = new Map<string, Grant>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Hold `value` for `agent` until `until`. Holding a name again replaces the earlier grant and its case id, since
   * a second approval of the same secret is a new decision and the old handle must stop meaning anything.
   */
  hold(options: HoldOptions): Grant {
    const now = options.now ?? this.now();
    const grant: Grant = {
      name: options.name,
      agent: options.agent,
      value: options.value,
      until: Math.min(options.until, now + MAX_UNTIL_MS),
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
      usedAt: now,
      caseId: options.caseId ?? randomId(4),
    };
    this.held.set(key(grant.agent, grant.name), grant);
    return grant;
  }

  /**
   * The value for `name`, or undefined when no grant is live. A live grant has its idle window restarted here; a
   * dead one is dropped as it is found. Both clocks are checked against the same instant, so a grant that has
   * reached its ceiling is dead even if it was used a moment ago.
   */
  take(agent: string, name: string, now = this.now()): string | undefined {
    const grant = this.held.get(key(agent, name));
    if (!grant) return undefined;
    if (!this.alive(grant, now)) {
      this.held.delete(key(agent, name));
      return undefined;
    }
    grant.usedAt = now;
    return grant.value;
  }

  /** Whether a live grant exists for `name`, without taking it or restarting its clock. */
  live(agent: string, name: string, now = this.now()): boolean {
    const grant = this.held.get(key(agent, name));
    return grant !== undefined && this.alive(grant, now);
  }

  /** The names this agent may use right now, for a caller about to inject each of them. */
  names(agent: string, now = this.now()): string[] {
    return [...this.held.values()]
      .filter((grant) => grant.agent === agent && this.alive(grant, now))
      .map((grant) => grant.name);
  }

  /**
   * Every live grant of this agent as `{name: value}`, for the environment of one command it is about to start. Each
   * one counts as a use, so its idle window restarts, and a dead one is dropped as it is found.
   */
  env(agent: string, now = this.now()): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.names(agent, now)) {
      const value = this.take(agent, name, now);
      if (value !== undefined) out[name] = value;
    }
    this.sweep(now);
    return out;
  }

  /** Kills the grant with this case id, and says whether one was found. Takes effect on the next `take`. */
  revoke(caseId: string): boolean {
    for (const [k, grant] of this.held) {
      if (grant.caseId !== caseId) continue;
      this.held.delete(k);
      return true;
    }
    return false;
  }

  /** Drops every dead grant. Nothing depends on this: `take` checks both clocks itself. */
  sweep(now = this.now()): number {
    let dropped = 0;
    for (const [k, grant] of this.held) {
      if (this.alive(grant, now)) continue;
      this.held.delete(k);
      dropped++;
    }
    return dropped;
  }

  /** What a card's answer may say about a grant: the case id and both clocks, never the value. */
  describe(grant: Grant): string {
    const until = new Date(grant.until).toISOString().slice(0, 16).replace('T', ' ');
    const idle = Math.round(grant.idleMs / 60_000);
    return `${grant.name} is available to this session until ${until} UTC, and dies after ${idle} min unused (case ${grant.caseId}).`;
  }

  private alive(grant: Grant, now: number): boolean {
    return now < grant.until && now - grant.usedAt < grant.idleMs;
  }
}
