// The loop every card.created extension runs: dial in on the extension stream, give each new card to a check, and
// send its verdict back. Triage uses it, and so does the example in examples/triage-agent. A check that throws passes
// the card, because a broken check must never keep a card from the person.
import type { HookEvent, ScreenMode } from '../core/hooks.ts';

export interface Ruling {
  verdict: 'pass' | 'return';
  reason: string;
  /** On a pass, text the inbox sends the card's agent as an `advice` event. */
  advice?: string;
}

export type CardCreated = Extract<HookEvent, { hook: 'card.created' }>;

/** A GET (no body) or POST to the inbox with the extension's token. */
export type InboxCall = <T>(route: string, body?: unknown) => Promise<T>;

/** `signal` aborts when the extension stops or the card's deadline passes, so a check can cancel the work it started. */
export type CardCheck = (ev: CardCreated, call: InboxCall, signal: AbortSignal) => Promise<Ruling>;

export interface CardHookConfig {
  url: string;
  token: string;
  name: string;
  /** How long the inbox waits for a verdict before it passes the card. The inbox caps it at ten minutes. */
  timeoutMs?: number;
  /** Checks at once. A burst of cards waits its turn instead of hitting a model's rate limit. */
  concurrency?: number;
  /** Which cards this connection screens: `open` also takes the open cards that have no verdict yet. Defaults to `new`. */
  screen?: ScreenMode;
  log?: (...a: unknown[]) => void;
  fetcher?: typeof fetch;
}

/** Run at most `limit` tasks at once, in arrival order. A limit below one runs one at a time. */
export function limiter(asked: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(asked) || 1);
  let active = 0;
  const queue: (() => void)[] = [];
  return async (task) => {
    // A finishing task hands its slot to the first waiter, so a task that arrives meanwhile can't take it too.
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    else active++;
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Run `check` on each new card until `signal` aborts. Reconnects after a drop, and the inbox resends calls it missed. */
export async function runCardHook(cfg: CardHookConfig, check: CardCheck, signal: AbortSignal): Promise<void> {
  const log = cfg.log ?? ((...a: unknown[]) => console.error(new Date().toISOString(), `[${cfg.name}]`, ...a));
  const fetcher = cfg.fetcher ?? fetch;
  const base = cfg.url.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
  const run = limiter(cfg.concurrency ?? 3);
  const call: InboxCall = async <T>(route: string, body?: unknown): Promise<T> => {
    const res = await fetcher(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`${route} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  };
  const decide = async (ev: CardCreated): Promise<void> => {
    let ruling: Ruling;
    // By its deadline the inbox has passed the card, so a check still running then gives up its slot: a check that
    // never settles must not keep every later card from its turn.
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(), Math.max(0, ev.deadline - Date.now()));
    // A check that ignores its abort keeps the race pending past a stop, so the stop clears the timer: it would
    // otherwise keep the process alive until the card's deadline.
    const onStop = (): void => clearTimeout(timer);
    if (signal.aborted) onStop();
    else signal.addEventListener('abort', onStop, { once: true });
    const ends = AbortSignal.any([signal, late.signal]);
    try {
      const tooLate = (): Error => new Error('it did not finish before the card\'s deadline');
      ruling = await run(() => {
        // A card whose deadline passed while it waited for a slot skips its check.
        if (late.signal.aborted) return Promise.reject(tooLate());
        return Promise.race([
          check(ev, call, ends),
          new Promise<never>((_, reject) => { late.signal.addEventListener('abort', () => reject(tooLate()), { once: true }); }),
        ]);
      });
    } catch (e) {
      ruling = { verdict: 'pass', reason: `${cfg.name} failed (${(e as Error).message}), so the card went through.` };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onStop);
    }
    try {
      await call(`/v1/hooks/${ev.id}`, ruling);
      log(ruling.verdict, ev.card.id, ruling.reason);
    } catch (e) {
      log('verdict failed:', ev.card.id, (e as Error).message);
    }
  };
  const q = new URLSearchParams({ name: cfg.name, hooks: 'card.created', policy: 'fail-open', timeoutMs: String(cfg.timeoutMs ?? 120_000), screen: cfg.screen ?? 'new' });
  while (!signal.aborted) {
    try {
      const res = await fetcher(`${base}/v1/extensions/stream?${q}`, { headers: auth, signal });
      if (!res.ok || !res.body) throw new Error(`stream: ${res.status} ${await res.text()}`);
      log('connected to', base);
      const reader = res.body.getReader();
      const cancel = (): void => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let end: number;
          while ((end = buf.indexOf('\n\n')) >= 0) {
            const data = buf.slice(0, end).split('\n').find((l) => l.startsWith('data: '));
            buf = buf.slice(end + 2);
            if (!data) continue;
            let ev: HookEvent | { type: 'beat' } | undefined;
            try {
              ev = JSON.parse(data.slice(6)) as HookEvent | { type: 'beat' } | undefined;
            } catch {
              ev = undefined;
            }
            if (!ev || typeof ev !== 'object') { log('skipped a frame it could not read:', data.slice(0, 100)); continue; }
            if (ev.type === 'hook' && ev.hook === 'card.created') void decide(ev);
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        // A stream that ends for any reason closes its connection before the next one opens.
        cancel();
      }
    } catch (e) {
      if (signal.aborted) return;
      log('stream failed:', (e as Error).message);
    }
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
