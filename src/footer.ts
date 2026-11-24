// The footer: one segment of a status line, printed by `your-attention footer`. It counts the cards that wait for the
// person, then links the first few in the page's queue order, each digit an OSC 8 hyperlink to its card. A status line
// runs on a timer, so this reads GET /v1/state once, with a short timeout, and says nothing at all when no inbox
// answers: a segment that printed an error, or stalled the line, would be worse than no segment.
//
// It prints only the count and the digits. No card field reaches the terminal, so an agent's words can never carry an
// escape sequence into the status line (SPEC.md, the terminal client's rule for card fields).
import path from 'node:path';
import { ownerPairing, runningHere } from './client.ts';
import type { InboxState } from '../web/queue.js';
import { buildQueue } from '../web/queue.js';
import { homeDir } from './node/home.ts';

/** The inbox the footer reads, and the place the token came from, as `status` names it. */
export interface FooterTarget { url: string; token: string; source: string }

/** The inbox whose state the footer shows, found in the order the owner commands find one: YOUR_ATTENTION_URL with
 * YOUR_ATTENTION_TOKEN first, then the inbox this machine runs, then the owner pairing. Both variables are needed;
 * one alone is what an agent's shell may carry, and the files decide instead. */
export function footerTarget(env: NodeJS.ProcessEnv = process.env, home = homeDir()): FooterTarget | undefined {
  const url = env['YOUR_ATTENTION_URL'];
  const token = env['YOUR_ATTENTION_TOKEN'];
  if (url && token) return { url: url.replace(/\/$/, ''), token, source: 'YOUR_ATTENTION_URL' };
  const local = runningHere(home);
  if (local) return { url: local.url.replace(/\/$/, ''), token: local.token, source: path.join(home, 'owner-token') };
  const paired = ownerPairing(home);
  return paired ? { url: paired.url, token: paired.token, source: paired.source } : undefined;
}

/** Whether a reply carries what the queue reads: another program on the address can answer 200 with JSON of its own,
 * and `buildQueue` would throw on it. A card needs an id the queue can link, and a level an id the queue can rank by;
 * one entry it cannot read makes the whole reply a reply that is not a state. */
function asState(data: unknown): InboxState | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const s = data as Partial<InboxState>;
  const objects = [s.answers, s.presence, s.states];
  if (!Array.isArray(s.cards) || !objects.every((o) => typeof o === 'object' && o !== null)) return undefined;
  if (!s.cards.every((c) => typeof c === 'object' && c !== null && typeof (c as { id?: unknown }).id === 'string')) return undefined;
  if (s.levels !== undefined && (!Array.isArray(s.levels) || !s.levels.every((l) => typeof l === 'object' && l !== null && typeof (l as { id?: unknown }).id === 'string'))) return undefined;
  if (s.priorities !== undefined && (typeof s.priorities !== 'object' || s.priorities === null)) return undefined;
  if (s.settings !== undefined && (typeof s.settings !== 'object' || s.settings === null)) return undefined;
  return s as InboxState;
}

/** GET /v1/state from the inbox, or undefined when it does not answer, refuses the token, or answers with something
 * else. The timeout keeps a stopped or unreachable inbox from stalling the status line. */
export async function footerState(target: Pick<FooterTarget, 'url' | 'token'>, timeoutMs = 2000): Promise<InboxState | undefined> {
  try {
    const res = await fetch(`${target.url}/v1/state`, {
      headers: { authorization: `Bearer ${target.token}`, 'x-your-attention': '1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return asState(await res.json());
  } catch {
    return undefined;
  }
}

/** One OSC 8 hyperlink: the text becomes clickable, and opens the target. Control bytes leave the target first, since
 * a stray ESC or BEL would end the sequence early and let the rest of the address inject terminal control. */
export function osc8(text: string, target: string): string {
  return `\x1b]8;;${target.replace(/[\x00-\x1f\x7f]/g, '')}\x07${text}\x1b]8;;\x07`;
}

/** The segment: `<n> card(s)`, then the first `max` cards of the page's queue order, each digit a link to its card.
 * The states that count are the queue's own: a card the person can answer, release or claim, and not one triage is
 * still checking, nor one in the outbox waiting for its agent (DP23). System cards and pinned groups keep the place
 * the page gives them. `max` cuts the links only: the count still says how many cards wait. */
export function footerSegment(state: InboxState, url: string, max = 5, agent?: string): string {
  const settings = state.settings ?? { allowHtml: false };
  // The settings object may hold anything at all on the wire, and only the shapes the queue reads go to it.
  const groupBy = typeof settings.groupBy === 'string' ? settings.groupBy : 'none';
  const pins = Array.isArray(settings.pins) ? settings.pins : [];
  const queue = buildQueue(state, groupBy, pins);
  // A session's status line can ask for that agent's cards alone: the ones it posted and the ones the person sent it.
  // Without a name, or with a blank one, the segment speaks for the whole inbox.
  const named = typeof agent === 'string' && agent.trim() !== '' ? agent.trim() : undefined;
  const owed = (cards: typeof queue.pending): typeof queue.pending => (named === undefined ? cards : cards.filter((c) => c.agent === named));
  const waiting = owed(queue.pending).length;
  if (waiting === 0) return '';
  const base = url.replace(/\/$/, '');
  const links = owed(queue.order).slice(0, Math.max(0, max)).map((card, i) => osc8(String(i + 1), `${base}/#card=${encodeURIComponent(card.id)}`));
  return `${waiting} card${waiting === 1 ? '' : 's'}${links.length ? ` ${links.join(' ')}` : ''}`;
}
