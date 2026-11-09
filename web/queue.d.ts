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
/** The ids of the sections every Group by choice shows. */
export const SECTION_ID: { replied: string; checking: string; outbox: string; sent: string };
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
  /** One group per pinned tag value, in pin order, with the waiting cards it holds and the id that names it. */
  pinned: { key: string; value: string; id: string; items: Card[] }[];
  replied: Card[];
  outbox: Card[];
  sent: Card[];
  tagKeys: string[];
  dealt: Card[];
  /** Each waiting group as [title, cards], with [key, value] third under a tag grouping when the group has a value, and its collapse id fourth. */
  groups: [string, Card[], [string, string] | undefined, string][];
  /** The collapse id of the group each card sits in: a pinned group, a grouped group, or a section. */
  groupOf: Record<string, string>;
  /** The cards of a collapsed group: the heading and the count keep them, the queue order does not. */
  hidden: Set<string>;
  order: Card[];
}
export function buildQueue(state: InboxState, groupBy: string, pins?: [string, string][], collapsed?: ReadonlySet<string>): Queue;
export function after(order: Card[], id: string | null): string | null;
