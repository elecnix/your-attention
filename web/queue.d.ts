import type { CardState, Guidance, Presence, PriorityLevel, Settings } from '../src/core/types.ts';
import type { AnswerSummary, CardSummary } from '../src/core/summary.ts';

type Card = CardSummary;

/** GET /v1/state. */
export interface InboxState {
  cards: Card[];
  answers: Record<string, AnswerSummary>;
  presence: Record<string, Presence>;
  states: Record<string, CardState>;
  priorities?: Record<string, string>;
  levels?: PriorityLevel[];
  settings?: Settings;
  /** The current card guidance, which a guidance card diffs its proposal against. */
  guidance?: Guidance;
}
export type ShownState = CardState | 'reply';
export const CLOSED_LABEL: Record<string, string>;
export const STATE_LABEL: Record<string, string>;
export function agentName(id: string, cards: Card[]): string;
export function presenceOf(card: Pick<Card, 'agent' | 'deliver'>, state: InboxState): ['off' | 'busy' | 'on', string] | null;
export interface Queue {
  byId: Record<string, Card>;
  st(c: Card): ShownState;
  levelOf(c: Card): string;
  label(id: string): string;
  waiting(s: ShownState): boolean;
  pending: Card[];
  checking: Card[];
  /** One group per pinned tag value, in pin order, with the waiting cards it holds. */
  pinned: { key: string; value: string; items: Card[] }[];
  replied: Card[];
  outbox: Card[];
  sent: Card[];
  tagKeys: string[];
  dealt: Card[];
  /** Each waiting group as [title, cards], with [key, value] third under a tag grouping when the group has a value. */
  groups: [string, Card[], [string, string]?][];
  order: Card[];
}
export function buildQueue(state: InboxState, groupBy: string, pins?: [string, string][]): Queue;
export function after(order: Card[], id: string | null): string | null;
