// Hook points and their contract. Extensions use these messages, which are
// separate from the messages agents and cards exchange, so the extension
// contract can change without touching the agent protocol.
import type { Answer, Card, PersonPresence } from './types.ts';

export const HOOK_VERSION = 1;

/** Each hook declares what an extension may do there. */
export const HOOKS = {
  /** Before the person sees a new or revised card. An extension may pass it, hold it, or return it to its agent. */
  'card.created': { verdicts: ['pass', 'hold', 'return'] as const, defaultTimeoutMs: 30_000 },
  /** After the person saves an answer. Observe only. */
  'answer.saved': { verdicts: [] as const, defaultTimeoutMs: 10_000 },
  /** When the person opens or closes the inbox, comes back to it, or moves to another card. Observe only. */
  'person.changed': { verdicts: [] as const, defaultTimeoutMs: 10_000 },
} as const;

export type HookName = keyof typeof HOOKS;
export type Verdict = 'pass' | 'hold' | 'return';
export type FailurePolicy = 'fail-open' | 'fail-closed';

/** What an extension receives for each hook call. */
export type HookEvent =
  | { type: 'hook'; version: number; id: string; hook: 'card.created'; card: Card; deadline: number; person: PersonPresence }
  | { type: 'hook'; version: number; id: string; hook: 'answer.saved'; card: Card; answer: Answer }
  | { type: 'hook'; version: number; id: string; hook: 'person.changed'; person: PersonPresence };

export interface ExtensionRegistration {
  name: string;
  hooks: HookName[];
  timeoutMs: number;
  policy: FailurePolicy;
}

export function isHook(name: string): name is HookName {
  return Object.hasOwn(HOOKS, name);
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 of the body with the webhook secret, as the x-your-attention-signature header carries it. */
export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`;
}

export interface Webhook {
  id: string;
  hook: HookName;
  url: string;
  secret: string;
}

/** Send a signed observe-only hook call to an external service over HTTPS. A failure never reaches the caller. */
export async function deliverWebhook(hook: Webhook, payload: unknown, fetcher: typeof fetch = fetch): Promise<boolean> {
  const body = JSON.stringify(payload);
  try {
    const res = await fetcher(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-your-attention-hook': hook.hook, 'x-your-attention-signature': await sign(hook.secret, body) },
      body,
      signal: AbortSignal.timeout(HOOKS[hook.hook].defaultTimeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
