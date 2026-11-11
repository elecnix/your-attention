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

/** One card from GET /v1/cards?ids=. */
export interface LinkedCard { title: string; preview?: string; archivedAt?: number }
export function linkIds(...texts: (string | null | undefined | false)[]): string[];
export interface LinkLookup {
  get(id: string): LinkedCard | null | undefined;
  want(ids: string[]): void;
}
export function linkLookup(load: (ids: string[]) => Promise<Record<string, LinkedCard>>, changed: () => void): LinkLookup;
