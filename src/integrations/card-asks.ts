// The asks for a card that a session gets after it goes inactive without one.
//
// A session whose turn ends starts a stretch of inactivity. It is asked at each delay of the rule, counted in minutes
// from the moment it went inactive, so the default asks land at 2, 5 and 10 minutes, not 2, 7 and 17. Any activity
// ends the stretch, and so does a card of its own. An ask starts a turn of the session's own, which is not activity:
// the stretch keeps its start, so the next ask still lands at its minute.
//
// The long-lived process beside the session runs the timer: the Claude Code channel, or the pi extension. The stretch
// lives in a store, which for Claude Code is a file the hooks write too, so a channel that restarts picks it up.
import type { CardRule } from './require-card.ts';

/** One stretch of inactivity without an open card. */
export interface Stretch {
  /** When the session went inactive, in milliseconds since the epoch. */
  since: number;
  /** How many delays of the rule this stretch has asked for. */
  asks: number;
  /** The session runs the turn an ask started, so a turn starting or a tool call in it is not activity. */
  ours?: boolean;
}

export interface StretchStore {
  load(): Stretch | undefined;
  save(stretch: Stretch | undefined): void;
}

/** A store in memory, for a harness whose extension lives as long as the session. */
export function memoryStore(): StretchStore {
  let held: Stretch | undefined;
  return {
    load: () => (held ? { ...held } : undefined),
    save: (next) => { held = next ? { ...next } : undefined; },
  };
}

/** Whether a value read back from a store is a stretch. */
export function isStretch(v: unknown): v is Stretch {
  const s = v as Stretch | null;
  return typeof s === 'object' && s !== null && Number.isFinite(s.since) && Number.isInteger(s.asks) && s.asks >= 0 && (s.ours === undefined || typeof s.ours === 'boolean');
}

/** The stretch after a turn ends: the turn an ask started keeps its stretch, and any other turn starts a new one. */
export function afterTurn(prev: Stretch | undefined, now: number): Stretch {
  return prev?.ours ? { since: prev.since, asks: prev.asks } : { since: now, asks: 0 };
}

const same = (a: Stretch | undefined, b: Stretch | undefined): boolean =>
  a?.since === b?.since && a?.asks === b?.asks && Boolean(a?.ours) === Boolean(b?.ours);

export interface CardAsksOptions {
  store: StretchStore;
  /** The rule this session obeys now. Read before each ask, so a change reaches a running session. */
  rule(): Promise<CardRule>;
  hasOpenCard(): Promise<boolean>;
  /** Ask the session for a card. The ask starts a turn of the session's own. */
  ask(): Promise<void> | void;
  /** How long a minute of the schedule lasts. Tests shorten it. */
  minuteMs?: number;
  log?: (...a: unknown[]) => void;
}

export class CardAsks {
  private readonly o: CardAsksOptions;
  private readonly minuteMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every change, so a timer or a read that a later change overtook does nothing. */
  private gen = 0;

  constructor(options: CardAsksOptions) {
    this.o = options;
    this.minuteMs = options.minuteMs ?? 60_000;
  }

  /** The session's turn ended: it is inactive from now, unless the turn was the one an ask started. */
  ended(): void {
    this.o.store.save(afterTurn(this.o.store.load(), Date.now()));
    this.resync();
  }

  /** A turn started or a tool ran. Activity, unless the session runs the turn an ask started. */
  began(): void {
    if (this.o.store.load()?.ours) return;
    this.activity();
  }

  /** Something happened that no ask caused: a person message, an answer, a card of its own. */
  activity(): void {
    this.cancel();
    this.o.store.save(undefined);
  }

  /** Stop the timer and keep the stretch, for a process that ends while the session goes on. */
  stop(): void {
    this.cancel();
  }

  /** Read the stretch from the store and set the timer for its next ask. Call it whenever the store may have changed. */
  async sync(): Promise<void> {
    const gen = this.cancel();
    const stretch = this.o.store.load();
    if (!stretch || stretch.ours) return;
    const rule = await this.readRule();
    if (!rule?.on || gen !== this.gen) return;
    const next = rule.delays[stretch.asks];
    if (next === undefined) return;
    const wait = Math.max(0, stretch.since + next * this.minuteMs - Date.now());
    const timer = setTimeout(() => {
      // A store that fails to write, such as a full disk, must not end the process as an unhandled rejection.
      this.fire(gen).catch((e: Error) => this.o.log?.('the ask for a card failed:', e.message));
    }, wait);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** sync, for a caller that does not wait: a failure is logged rather than left unhandled. */
  resync(): void {
    this.sync().catch((e: Error) => this.o.log?.('could not time the asks for a card:', e.message));
  }

  private cancel(): number {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return ++this.gen;
  }

  private async readRule(): Promise<CardRule | undefined> {
    try {
      return await this.o.rule();
    } catch (e) {
      this.o.log?.('could not read the card rule:', (e as Error).message);
      return undefined;
    }
  }

  private async fire(gen: number): Promise<void> {
    this.timer = undefined;
    const stretch = this.o.store.load();
    if (gen !== this.gen || !stretch || stretch.ours) return;
    const rule = await this.readRule();
    if (!rule?.on || gen !== this.gen) return;
    // A process that was away asks once for every delay it missed, rather than once per delay.
    const due = rule.delays.filter((d) => d * this.minuteMs <= Date.now() - stretch.since).length;
    if (due <= stretch.asks) return this.resync();
    let open: boolean;
    try {
      open = await this.o.hasOpenCard();
    } catch (e) {
      this.o.log?.('could not read the session cards:', (e as Error).message);
      return;
    }
    // A hook may have written the store while the inbox answered: that change wins.
    if (gen !== this.gen || !same(this.o.store.load(), stretch)) return this.resync();
    // A card of its own is what the asks are for, so it ends the stretch.
    if (open) return void this.o.store.save(undefined);
    this.o.store.save({ since: stretch.since, asks: due, ours: true });
    try {
      await this.o.ask();
    } catch (e) {
      this.o.log?.('could not ask for a card:', (e as Error).message);
      // An ask that never left starts no turn, so the stretch goes on to its next delay.
      if (same(this.o.store.load(), { since: stretch.since, asks: due, ours: true })) {
        this.o.store.save({ since: stretch.since, asks: due });
        this.resync();
      }
    }
  }
}
