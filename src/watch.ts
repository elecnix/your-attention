// What `your-attention watch` prints: one line of JSON for each event an agent stream sends,
// so a script reads the inbox as a stream. The line is the inbox's own event, unchanged,
// plus `receivedAt`: a watcher that renamed or reshaped the fields would be a second dialect
// to learn, and the events already carry the types in `src/core/types.ts`.
import type { AgentEvent, Card } from './core/types.ts';

export interface WatchOptions {
  /** Card fields to keep, such as `id,title`. Every other field is left out. Undefined keeps them all. */
  fields?: string[] | undefined;
  /** Leave the card out: a watcher that keys its cards by id does not need the question again. */
  noCard?: boolean;
}

type WithoutCard<T> = T extends { card: Card } ? Omit<T, 'card'> & { card?: Partial<Card> } : T;

/** One line of `your-attention watch` output. */
export type WatchLine = WithoutCard<AgentEvent> & { receivedAt: number };

/** The line for one event, cut to the fields the watcher asked for. */
export function watchLine(event: AgentEvent, options: WatchOptions, receivedAt: number): WatchLine {
  if (event.type !== 'answer' && event.type !== 'returned') return { ...event, receivedAt };
  const { card, ...rest } = event;
  const kept = options.noCard ? undefined : options.fields ? pickCard(card, options.fields) : card;
  return { ...rest, ...(kept === undefined ? {} : { card: kept }), receivedAt } as WatchLine;
}

/** The card, cut to the fields a watcher named. A name the card does not carry is left out, so a
 * field an inbox does not send never looks like a field with an empty value. */
export function pickCard(card: Card, fields: string[]): Partial<Card> {
  const whole = card as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in whole) out[field] = whole[field];
  return out as Partial<Card>;
}
