// The PIN that a browser tab types before it acts as the owner. The client runs
// the slow salted hash, PBKDF2, and sends the derived key, never the PIN. The
// inbox keeps a SHA-256 hash of that key, and a hash of each unlock token it
// gives a tab. Wrong tries and their lockout live in storage, so a restart
// keeps them.
import { randomId, sha256 } from './crypto.ts';
import type { Storage } from './storage.ts';

/** About 100 ms of PBKDF2-SHA256 on a laptop. The client computes it on every build, with the count GET /v1/pin hands out. */
export const PIN_ITERATIONS = 800_000;
/** Wrong tries before a lockout. */
export const PIN_TRIES = 5;
/** The first lockout. Each one after it lasts twice as long as the one before, up to a day. */
export const FIRST_LOCKOUT_MS = 60_000;
export const MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
/** An unlock token that no request has used for this long ends. */
export const UNLOCK_IDLE_MS = 12 * 60 * 60 * 1000;
/** The header that carries a tab's unlock token. */
export const UNLOCK_HEADER = 'x-your-attention-unlock';
const MAX_UNLOCKS = 32;
/** How often a token in use writes its last use, so each request does not write to storage. */
const TOUCH_MS = 60_000;

/** What a client sends for a new PIN: the PBKDF2-SHA256 key it derived, in hex, with the salt and iterations it used. */
export interface PinKey { key: string; salt: string; iterations: number }
/** `key` is the SHA-256 of the derived key. An inbox from before the client derived keeps the derived key itself in `hash`. */
interface PinRecord { key?: string; hash?: string; salt?: string; iterations?: number; setAt?: number; neverAsk?: boolean }
interface Tries { failures: number; lockouts: number; until: number }
interface Unlock { key: string; hash: string; token: string; seen: number }

export interface PinStatus {
  set: boolean;
  /** What a client derives the key of the PIN that is set with: its salt, or null, and its iterations. */
  salt: string | null;
  iterations: number;
  /** The iterations a new PIN's key must use. */
  newIterations: number;
  /** The person chose to never be asked to set a PIN. */
  neverAsk: boolean;
  /** Until when wrong tries locked the PIN, or null. */
  lockedUntil: number | null;
  triesLeft: number;
}

export type UnlockResult = { ok: true; token: string } | { ok: false; triesLeft: number } | { ok: false; lockedUntil: number };

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** The key a client sends for a PIN: PBKDF2-SHA256 over the PIN, 32 bytes in hex. web/pin-key.js computes the same on the page. */
export async function pinKey(pin: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations }, key, 256)));
}

/** A new PIN's key, with a fresh random 16-byte salt. */
export async function newPinKey(pin: string, iterations = PIN_ITERATIONS): Promise<PinKey> {
  if (!validPin(pin)) throw new RangeError('a PIN is 4 digits');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { key: await pinKey(pin, salt, iterations), salt, iterations };
}

/** Two strings of the same length compared in time that does not depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const validPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\d{4}$/.test(pin);
/** A derived key as a client sends it: 32 bytes in lowercase hex. */
export const validKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);

/** Why the inbox refuses a new PIN's key, or undefined when it takes it. */
export function pinKeyError(k: unknown, iterations = PIN_ITERATIONS): string | undefined {
  const v = (k && typeof k === 'object' ? k : {}) as Partial<PinKey>;
  if (!validKey(v.key)) return 'key must be the PIN derived with PBKDF2-SHA256, 32 bytes in lowercase hex';
  if (typeof v.salt !== 'string' || !/^[0-9a-f]{32}$/.test(v.salt)) return 'salt must be 16 random bytes in lowercase hex';
  if (v.iterations !== iterations) return `iterations must be ${iterations}, the newIterations of GET /v1/pin`;
  return undefined;
}

export class PinLock {
  private readonly store: Storage;
  private readonly now: () => number;
  /** The PBKDF2 iterations a new PIN's key must use. */
  readonly iterations: number;
  private readonly listeners = new Set<() => void>();

  constructor(store: Storage, now: () => number = Date.now, iterations = PIN_ITERATIONS) {
    this.store = store;
    this.now = now;
    this.iterations = iterations;
  }

  private record(): PinRecord {
    return this.store.get<PinRecord>('meta', 'pin') ?? {};
  }

  private tries(): Tries {
    return this.store.get<Tries>('meta', 'pin-tries') ?? { failures: 0, lockouts: 0, until: 0 };
  }

  isSet(): boolean {
    const r = this.record();
    return !!(r.key || r.hash);
  }

  status(): PinStatus {
    const r = this.record();
    const t = this.tries();
    const locked = t.until > this.now();
    const set = this.isSet();
    return {
      set, salt: set ? r.salt ?? null : null, iterations: set ? r.iterations ?? this.iterations : this.iterations, newIterations: this.iterations,
      neverAsk: r.neverAsk === true, lockedUntil: locked ? t.until : null, triesLeft: locked ? 0 : PIN_TRIES - t.failures,
    };
  }

  /** Runs after the PIN changes or goes, once every unlock token has ended. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Set a PIN typed in this process, such as at the laptop's terminal. Clients send the key to setKey instead. */
  async set(pin: string): Promise<void> {
    await this.setKey(await newPinKey(pin, this.iterations));
  }

  /** Set the PIN from the key a client derived. The inbox stores the SHA-256 of the key. */
  async setKey(k: PinKey): Promise<void> {
    const error = pinKeyError(k, this.iterations);
    if (error) throw new RangeError(error);
    const key = await sha256(k.key);
    const { neverAsk } = this.record();
    this.store.put<PinRecord>('meta', 'pin', { key, salt: k.salt, iterations: k.iterations, setAt: this.now(), ...(neverAsk !== undefined ? { neverAsk } : {}) });
    this.store.delete('meta', 'pin-tries');
    this.dropUnlocks();
  }

  clear(): void {
    const { neverAsk } = this.record();
    this.store.put<PinRecord>('meta', 'pin', neverAsk ? { neverAsk } : {});
    this.store.delete('meta', 'pin-tries');
    this.dropUnlocks();
  }

  setNeverAsk(neverAsk: boolean): void {
    this.store.put<PinRecord>('meta', 'pin', { ...this.record(), neverAsk });
  }

  /** Check a derived key against the lockout. Each try counts before the hash runs, so tries sent at once all count. */
  async check(key: string): Promise<{ ok: true } | { ok: false; triesLeft: number } | { ok: false; lockedUntil: number }> {
    const r = this.record();
    if (!this.isSet()) return { ok: false, triesLeft: 0 };
    const now = this.now();
    const t = this.tries();
    if (t.until > now) return { ok: false, lockedUntil: t.until };
    const failures = t.failures + 1;
    const next: Tries = failures >= PIN_TRIES
      ? { failures: 0, lockouts: t.lockouts + 1, until: now + Math.min(FIRST_LOCKOUT_MS * 2 ** t.lockouts, MAX_LOCKOUT_MS) }
      : { ...t, failures };
    this.store.put('meta', 'pin-tries', next);
    // An older laptop inbox stored the derived key itself, so its hash is the SHA-256 of that.
    const expected = r.key ?? (await sha256(r.hash ?? ''));
    if (validKey(key) && same(await sha256(key), expected)) {
      this.store.delete('meta', 'pin-tries');
      return { ok: true };
    }
    return next.until > now ? { ok: false, lockedUntil: next.until } : { ok: false, triesLeft: PIN_TRIES - failures };
  }

  /** Give a tab an unlock token for the owner token it signed in with, when the key is right. */
  async unlock(key: string, token: string): Promise<UnlockResult> {
    const r = await this.check(key);
    return r.ok ? { ok: true, token: await this.issue(token) } : r;
  }

  /** A new unlock token for one owner token. The secret is returned once. */
  async issue(token: string): Promise<string> {
    const id = randomId(8);
    const secret = `${id}.${randomId(32)}`;
    const live = this.unlocks().sort((a, b) => b.seen - a.seen);
    for (const old of live.slice(MAX_UNLOCKS - 1)) this.store.delete('meta', old.key);
    this.store.put<Unlock>('meta', `unlock:${id}`, { key: `unlock:${id}`, hash: await sha256(secret), token, seen: this.now() });
    return secret;
  }

  /** The id of a live unlock token that belongs to this owner token, or undefined. */
  async verifyUnlock(secret: string | null | undefined, token: string): Promise<string | undefined> {
    if (!secret) return undefined;
    const id = secret.split('.')[0] ?? '';
    if (!/^[0-9a-f]{16}$/.test(id)) return undefined;
    // Hash before the read, so a PIN change between the read and the touch below cannot bring a dropped token back.
    const hash = await sha256(secret);
    const u = this.store.get<Unlock>('meta', `unlock:${id}`);
    if (!u || u.token !== token || !same(hash, u.hash)) return undefined;
    const now = this.now();
    if (now - u.seen > UNLOCK_IDLE_MS) { this.store.delete('meta', u.key); return undefined; }
    if (now - u.seen > TOUCH_MS) this.store.put<Unlock>('meta', u.key, { ...u, seen: now });
    return id;
  }

  /** Whether an unlock token, by id, is still live. For a connection that unlocked when it opened. */
  live(id: string | undefined): boolean {
    const u = id ? this.store.get<Unlock>('meta', `unlock:${id}`) : undefined;
    return !!u && this.now() - u.seen <= UNLOCK_IDLE_MS;
  }

  /** End one tab's unlock token. */
  async lock(secret: string): Promise<void> {
    const id = String(secret).split('.')[0] ?? '';
    const hash = await sha256(String(secret));
    const u = /^[0-9a-f]{16}$/.test(id) ? this.store.get<Unlock>('meta', `unlock:${id}`) : undefined;
    if (u && same(hash, u.hash)) this.store.delete('meta', u.key);
  }

  /** End every unlock token, or those of one owner token, such as one that was revoked. */
  dropUnlocks(token?: string): void {
    for (const u of this.unlocks()) if (token === undefined || u.token === token) this.store.delete('meta', u.key);
    for (const l of this.listeners) l();
  }

  sweep(): void {
    const now = this.now();
    for (const u of this.unlocks()) if (now - u.seen > UNLOCK_IDLE_MS) this.store.delete('meta', u.key);
  }

  private unlocks(): Unlock[] {
    return this.store.list<{ key?: unknown }>('meta').filter((m): m is Unlock => typeof m?.key === 'string' && m.key.startsWith('unlock:'));
  }
}
