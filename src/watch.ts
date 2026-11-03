// What `your-attention watch` prints: one line of JSON for each event an agent stream sends,
// so a script reads the inbox as a stream. The line is the inbox's own event, unchanged,
// plus `receivedAt`: a watcher that renamed or reshaped the fields would be a second dialect
// to learn, and the events already carry the types in `src/core/types.ts`.
//
// An owner watcher follows the page events instead. A page event names a changed card by its id
// only, so the watcher fetches the card and prints it whole, as the agent stream does.
import type { AgentEvent, Answer, Card, CardState, PageEvent } from './core/types.ts';

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
  return { ...rest, ...cut(card, options), receivedAt } as WatchLine;
}

/** The card a line keeps, as `{card}`, or nothing with --no-card. */
function cut(card: Card, options: WatchOptions): { card?: Partial<Card> } {
  if (options.noCard) return {};
  return { card: options.fields ? pickCard(card, options.fields) : card };
}

/** The card, cut to the fields a watcher named. A name the card does not carry is left out, so a
 * field an inbox does not send never looks like a field with an empty value. */
export function pickCard(card: Card, fields: string[]): Partial<Card> {
  const whole = card as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in whole) out[field] = whole[field];
  return out as Partial<Card>;
}

/** What `GET /v1/cards/<id>` answers the owner. */
export interface CardDetail { card: Card; answer?: Answer | undefined; state: CardState; rev?: string | undefined }

/** A change to one card, with the card as the inbox stores it now. `id` is the card's id. It is empty
 * when many cards changed at once, as after `clear`, and the line carries no card when the card is gone. */
export interface OwnerChange { type: 'change'; id: string; card?: Card; answer?: Answer; state?: CardState; rev?: string }

/** What an owner watcher receives: the page events, with each change carrying its card, and a `hello`
 * the watcher writes itself each time the page socket opens, since the page socket sends none. */
export type OwnerEvent = OwnerChange | Exclude<PageEvent, { type: 'change' } | { type: 'beat' }> | { type: 'hello'; role: 'owner' };

/** One line of `your-attention watch --role owner` output. */
export type OwnerLine = (Omit<OwnerChange, 'card'> & { card?: Partial<Card> } | Exclude<OwnerEvent, OwnerChange>) & { receivedAt: number };

/** The owner event for one page event, with the card `GET /v1/cards/<id>` returned for a change. */
export function ownerEvent(event: Exclude<PageEvent, { type: 'beat' }>, detail: CardDetail | undefined): OwnerEvent {
  if (event.type !== 'change') return event;
  if (!detail) return { type: 'change', id: event.card };
  return {
    type: 'change',
    id: event.card,
    card: detail.card,
    ...(detail.answer ? { answer: detail.answer } : {}),
    state: detail.state,
    ...(detail.rev === undefined ? {} : { rev: detail.rev }),
  };
}

/** The line for one owner event, cut to the fields the watcher asked for. */
export function ownerLine(event: OwnerEvent, options: WatchOptions, receivedAt: number): OwnerLine {
  if (event.type !== 'change' || !event.card) return { ...event, receivedAt };
  const { card, ...rest } = event;
  return { ...rest, ...cut(card, options), receivedAt };
}

export interface WatchFilter {
  /** Event types to keep, such as `change` or `answer`. Undefined keeps every type. */
  types?: string[] | undefined;
  /** For an owner watcher: keep the cards and presence of this agent only. */
  agent?: string | undefined;
}

/** Whether a watcher prints an event. The filter reads the whole event, before --select or --no-card cut the card. */
export function keepEvent(event: AgentEvent | OwnerEvent, filter: WatchFilter): boolean {
  if (filter.types && !filter.types.includes(event.type)) return false;
  if (filter.agent === undefined || event.type === 'hello') return true;
  const agent = 'card' in event && event.card && typeof event.card === 'object' ? event.card.agent : 'agent' in event ? event.agent : undefined;
  return agent === filter.agent;
}

/** What a watcher says when it printed answers without acknowledging them. The ids come from the events, not from the
 * line, because `--no-card` and a `--select` that drops the id keep the card out of what was printed. */
export function unackedNotice(ids: string[]): string {
  const one = ids.length === 1;
  const how = ids.length <= 5 ? `: your-attention ack ${ids.join(' ')}` : ', one at a time with `your-attention ack <card>`.';
  return `Printed ${ids.length} answer${one ? '' : 's'} without acknowledging, so ${one ? 'that card stays' : 'those cards stay'} in the person's outbox as unread. Pass --ack next time${how}`;
}
