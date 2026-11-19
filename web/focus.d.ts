import type { CardSummary } from '../src/core/summary.ts';
import type { Pin } from '../src/core/types.ts';
import type { InboxState } from './queue.js';

/** The cards that arrived while focus was on and now wait for the person. `ids` are the cards listed when focus began. */
export function arrivals(ids: string[], live: InboxState, cardId: string): CardSummary[];
/** The cards among `cards` that raise a notification under the person's collapsed groups. */
export function notifiable(live: InboxState, cards: CardSummary[], groupBy: string, pins: Pin[], collapsed: Set<string>): CardSummary[];
/** The one notification the page raises when focus ends, or null when no card arrived. */
export function releaseNotice(cards: CardSummary[]): { title: string; body: string } | null;
/** Focus mode as this tab stored it, or null. */
export function readFocusMode(value: unknown): { card: string; ids: string[]; pageY: number; queueY: number } | null;
