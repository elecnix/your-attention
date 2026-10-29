import type { Answer, Card, CardState, Presence, PriorityLevel, Settings } from '../src/core/types.ts';

/** GET /v1/state. */
export interface InboxState {
  cards: Card[];
  answers: Record<string, Answer>;
  presence: Record<string, Presence>;
  states: Record<string, CardState>;
  priorities?: Record<string, string>;
  levels?: PriorityLevel[];
  settings?: Settings;
}
export type ShownState = CardState | 'reply';
export const CLOSED_LABEL: Record<string, string>;
export const STATE_LABEL: Record<string, string>;
export function agentName(id: string, cards: Card[]): string;
export function presenceOf(card: Card, state: InboxState): ['off' | 'busy' | 'on', string] | null;
export interface Queue {
  byId: Record<string, Card>;
  st(c: Card): ShownState;
  levelOf(c: Card): string;
  label(id: string): string;
  waiting(s: ShownState): boolean;
  pending: Card[];
  checking: Card[];
  replied: Card[];
  outbox: Card[];
  sent: Card[];
  tagKeys: string[];
  dealt: Card[];
  groups: [string, Card[]][];
  order: Card[];
}
export function buildQueue(state: InboxState, groupBy: string): Queue;
export function after(order: Card[], id: string | null): string | null;
