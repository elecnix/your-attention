import type { CardSummary } from '../src/core/summary.ts';
import type { Pin } from '../src/core/types.ts';
import type { InboxState } from './queue.js';

/** The state the page draws while focus is on: the held state, with the open card's summary, state, priority and answer from the live one. */
export function holdView(held: InboxState, live: InboxState, cardId: string): InboxState;
/** The held state after a reload: the live state with only the cards that were listed when focus began. */
export function heldFrom(live: InboxState, ids: string[]): InboxState;
/** The cards that arrived while focus was on and now wait for the person. */
export function arrivals(held: InboxState, live: InboxState, cardId: string): CardSummary[];
/** The cards among `cards` that raise a notification under the person's collapsed groups. */
export function notifiable(live: InboxState, cards: CardSummary[], groupBy: string, pins: Pin[], collapsed: Set<string>): CardSummary[];
/** The one notification the page raises when focus ends, or null when no card arrived. */
export function releaseNotice(cards: CardSummary[]): { title: string; body: string } | null;
/** Focus mode as this tab stored it, or null. */
export function readFocusMode(value: unknown): { card: string; ids: string[] } | null;
