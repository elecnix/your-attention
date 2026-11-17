// The loop every card.created extension runs: dial in on the extension stream, give each new card to a check, and
// send its verdict back. Triage uses it, and so does the example in examples/triage-agent. A check that throws passes
// the card, because a broken check must never keep a card from the person.
import type { HookEvent } from '../core/hooks.ts';

export interface Ruling {
  verdict: 'pass' | 'return';
  reason: string;
}

export type CardCreated = Extract<HookEvent, { hook: 'card.created' }>;

/** A GET (no body) or POST to the inbox with the extension's token. */
export type InboxCall = <T>(route: string, body?: unknown) => Promise<T>;

/** `signal` aborts when the extension stops, so a check can cancel the work it started. */
export type CardCheck = (ev: CardCreated, call: InboxCall, signal: AbortSignal) => Promise<Ruling>;

export interface CardHookConfig {
  url: string;
  token: string;
  name: string;
  /** How long the inbox waits for a verdict before it passes the card. The inbox caps it at ten minutes. */
  timeoutMs?: number;
  /** Checks at once. A burst of cards waits its turn instead of hitting a model's rate limit. */
  concurrency?: number;
  log?: (...a: unknown[]) => void;
  fetcher?: typeof fetch;
}

/** Run at most `limit` tasks at once, in arrival order. */
export function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (task) => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
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
    return (await res.json()) as T;
  };
  const decide = async (ev: CardCreated): Promise<void> => {
    let ruling: Ruling;
    try {
      ruling = await run(() => check(ev, call, signal));
    } catch (e) {
      ruling = { verdict: 'pass', reason: `${cfg.name} failed (${(e as Error).message}), so the card went through.` };
    }
    await call(`/v1/hooks/${ev.id}`, ruling).catch((e: Error) => log('verdict failed:', e.message));
    log(ruling.verdict, ev.card.id, ruling.reason);
  };
  const q = new URLSearchParams({ name: cfg.name, hooks: 'card.created', policy: 'fail-open', timeoutMs: String(cfg.timeoutMs ?? 120_000) });
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
            const ev = JSON.parse(data.slice(6)) as HookEvent | { type: 'beat' };
            if (ev.type === 'hook' && ev.hook === 'card.created') void decide(ev);
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    } catch (e) {
      if (signal.aborted) return;
      log('stream failed:', (e as Error).message);
    }
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
