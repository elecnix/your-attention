import type { Card, Answer } from '../src/core/types.ts';
import type { CardSummary } from '../src/core/summary.ts';

/** A piece of text a search matched in, split around the first match. */
export interface Snippet { label: string; before: string; hit: string; after: string }
/** The words of a query: lowercase, split on spaces, empty for a blank query. */
export function searchTerms(query: string): string[];
/** Null when the card does not match every term, else where the first term matched outside the title. */
export function matchCard(terms: string[], summary: CardSummary, detail?: { card?: Card; answer?: Answer }): { snippet?: Snippet } | null;
/** The parts of a text, each flagged when it matches a term, for highlighting. */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[];
