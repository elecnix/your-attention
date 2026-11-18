import type { Answer, Card, CardState, CloseKind } from '../src/core/types.ts';
import type { CardSummary } from '../src/core/summary.ts';

/** GET /v1/cards/<id>. */
export interface CardDetail { card: Card; answer?: Answer; state: CardState; rev?: string }
export interface CardDetails {
  get(summary: CardSummary | null | undefined): CardDetail | undefined;
  want(summaries: (CardSummary | null | undefined)[]): void;
  tried(id: string): boolean;
  keep(ids: Set<string>): void;
}
export function cardDetails(load: (id: string) => Promise<CardDetail>, changed: () => void): CardDetails;

/** How a linked card ended: its state, its close kind, and when the person answered or the card closed. */
export interface LinkOutcome { state: CardState | string; kind?: CloseKind | string; at?: number }
/** One card from GET /v1/cards?ids=. */
export interface LinkedCard { title: string; preview?: string; archivedAt?: number; outcome?: LinkOutcome }
export function linkIds(...texts: (string | null | undefined | false)[]): string[];
export function ownLinkIds(here: string, ...texts: (string | null | undefined | false)[]): string[];
export function summaryOutcome(card: Pick<CardSummary, 'closed'> | undefined, state: CardState | undefined, answer: { savedAt: number } | undefined): LinkOutcome | undefined;
/** The marker a link shows for a card that ended, or null for a card still waiting. */
export interface LinkMarker { key: string; word: string; title: string }
export function linkOutcome(outcome: LinkOutcome | undefined): LinkMarker | null;
export interface LinkLookup {
  get(id: string): LinkedCard | null | undefined;
  want(ids: string[]): void;
}
export function linkLookup(load: (ids: string[]) => Promise<Record<string, LinkedCard>>, changed: () => void): LinkLookup;
