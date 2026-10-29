// The PIN that a browser tab types before it acts as the owner. The inbox keeps
// a slow salted hash of the PIN, never the PIN, and a hash of each unlock token
// it gives a tab. Wrong tries and their lockout live in storage, so a restart
// keeps them.
import { randomId, sha256 } from './crypto.ts';
import type { Storage } from './storage.ts';

/** About 100 ms of PBKDF2-SHA256 on a laptop. */
export const PIN_ITERATIONS = 800_000;
/** The most PBKDF2 iterations the Workers runtime computes. */
export const WORKERS_PIN_ITERATIONS = 100_000;
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

export interface PinHash { hash: string; salt: string; iterations: number }
interface PinRecord extends Partial<PinHash> { setAt?: number; neverAsk?: boolean }
interface Tries { failures: number; lockouts: number; until: number }
interface Unlock { key: string; hash: string; token: string; seen: number }

export interface PinStatus {
  set: boolean;
  /** The person chose to never be asked to set a PIN. */
  neverAsk: boolean;
  /** Until when wrong tries locked the PIN, or null. */
  lockedUntil: number | null;
  triesLeft: number;
}

export type UnlockResult = { ok: true; token: string } | { ok: false; triesLeft: number } | { ok: false; lockedUntil: number };

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** Two strings of the same length compared in time that does not depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const validPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\d{4}$/.test(pin);

export async function hashPin(pin: string, iterations = PIN_ITERATIONS): Promise<PinHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: hex(await derive(pin, salt, iterations)), salt: hex(salt), iterations };
}

export async function verifyPin(pin: string, stored: PinHash): Promise<boolean> {
  return same(hex(await derive(pin, unhex(stored.salt), stored.iterations)), stored.hash);
}

export class PinLock {
  private readonly store: Storage;
  private readonly now: () => number;
  private readonly iterations: number;
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
    return !!this.record().hash;
  }

  status(): PinStatus {
    const r = this.record();
    const t = this.tries();
    const locked = t.until > this.now();
    return { set: !!r.hash, neverAsk: r.neverAsk === true, lockedUntil: locked ? t.until : null, triesLeft: locked ? 0 : PIN_TRIES - t.failures };
  }

  /** Runs after the PIN changes or goes, once every unlock token has ended. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async set(pin: string): Promise<void> {
    if (!validPin(pin)) throw new RangeError('a PIN is 4 digits');
    const hashed = await hashPin(pin, this.iterations);
    this.store.put<PinRecord>('meta', 'pin', { ...this.record(), ...hashed, setAt: this.now() });
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

  /** Check a PIN against the lockout. Each try counts before the slow hash starts, so tries sent at once all count. */
  async check(pin: string): Promise<{ ok: true } | { ok: false; triesLeft: number } | { ok: false; lockedUntil: number }> {
    const r = this.record();
    if (!r.hash || !r.salt || !r.iterations) return { ok: false, triesLeft: 0 };
    const now = this.now();
    const t = this.tries();
    if (t.until > now) return { ok: false, lockedUntil: t.until };
    const failures = t.failures + 1;
    const next: Tries = failures >= PIN_TRIES
      ? { failures: 0, lockouts: t.lockouts + 1, until: now + Math.min(FIRST_LOCKOUT_MS * 2 ** t.lockouts, MAX_LOCKOUT_MS) }
      : { ...t, failures };
    this.store.put('meta', 'pin-tries', next);
    if (validPin(pin) && (await verifyPin(pin, { hash: r.hash, salt: r.salt, iterations: r.iterations }))) {
      this.store.delete('meta', 'pin-tries');
      return { ok: true };
    }
    return next.until > now ? { ok: false, lockedUntil: next.until } : { ok: false, triesLeft: PIN_TRIES - failures };
  }

  /** Give a tab an unlock token for the owner token it signed in with, when the PIN is right. */
  async unlock(pin: string, token: string): Promise<UnlockResult> {
    const r = await this.check(pin);
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
    const u = this.store.get<Unlock>('meta', `unlock:${id}`);
    if (!u || u.token !== token || !same(await sha256(secret), u.hash)) return undefined;
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
    const u = /^[0-9a-f]{16}$/.test(id) ? this.store.get<Unlock>('meta', `unlock:${id}`) : undefined;
    if (u && same(await sha256(secret), u.hash)) this.store.delete('meta', u.key);
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
