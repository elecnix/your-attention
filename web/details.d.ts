import type { Answer, Card, CardState } from '../src/core/types.ts';
import type { CardSummary } from '../src/core/summary.ts';

/** GET /v1/cards/<id>. */
export interface CardDetail { card: Card; answer?: Answer; state: CardState; rev?: string }
export interface CardDetails {
  get(summary: CardSummary | null | undefined): CardDetail | undefined;
  want(summaries: (CardSummary | null | undefined)[]): void;
  keep(ids: Set<string>): void;
}
export function cardDetails(load: (id: string) => Promise<CardDetail>, changed: () => void): CardDetails;
