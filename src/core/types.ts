// The message model, version 1. SPEC.md describes each field and rule.

export const PROTOCOL_VERSION = 1;

export type Priority = 'now' | 'soon' | 'later';
export type CardKind = 'ask' | 'blocked' | 'system';
export type CloseKind = 'retracted' | 'self-answered' | 'answered-in-terminal' | 'resolved';
export type CardState = 'open' | 'answered' | 'delivered' | 'read' | 'closed';
export type Delivery = 'default' | 'steer' | 'followUp' | 'force';
export type Role = 'owner' | 'agent';

export interface Option {
  id: string;
  label: string;
  description?: string;
}

/** The shape of one question in Claude Code's AskUserQuestion tool. */
export interface AskQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface Origin {
  harness?: string;
  session?: string;
  name?: string;
  host?: string;
  cwd?: string;
  herdrPane?: string;
}

export interface Reply {
  text: string;
  at: number;
  seenAt: number | null;
}

export interface Closure {
  kind: CloseKind;
  outcome: string;
  at: number;
}

export interface Card {
  id: string;
  /** The agent that receives the answer. One agent is one harness session. */
  agent: string;
  /** The id of the token that posted the card. Never sent to clients. */
  token?: string;
  kind: CardKind;
  title: string;
  text?: string;
  recommendation?: string;
  /** OpenUI Lang source. Without it the page builds the card from the fields above. */
  body?: string;
  options?: Option[];
  multiple?: boolean;
  questions?: AskQuestion[];
  /** The terminal screen of a blocked agent. */
  screen?: string;
  priority: Priority;
  origin?: Origin;
  /** Other properties the agent attaches, for grouping. */
  tags?: Record<string, string>;
  /** The card this one follows, and the card that follows it. */
  follows?: string;
  followedBy?: string;
  /** "none" for a card that only shows state, such as a blocked agent. */
  deliver: 'stream' | 'none';
  version: number;
  createdAt: number;
  updatedAt: number;
  closed?: Closure;
  replies: Reply[];
}

export interface Answer {
  card: string;
  /** The card version the person answered. */
  version: number;
  /** Form values by field name. Every field is optional. */
  values: Record<string, unknown>;
  comment: string;
  delivery: Delivery;
  savedAt: number;
  deliveredAt: number | null;
  readAt: number | null;
  forcedAt: number | null;
  previous: Omit<Answer, 'previous'>[];
}

export interface Token {
  id: string;
  /** SHA-256 of the secret, hex. The secret itself is never stored. */
  hash: string;
  name: string;
  role: Role;
  createdAt: number;
}

export interface Pairing {
  id: string;
  name: string;
  role: Role;
  code: string;
  status: 'pending' | 'approved' | 'denied';
  /** Set once when approved, removed after the client collects it. */
  secret?: string;
  createdAt: number;
}

export interface Presence {
  agent: string;
  online: boolean;
  lastSeen: number;
}

/** What an agent stream receives for each answer. */
export interface AnswerEvent {
  type: 'answer';
  id: string;
  card: Card;
  answer: Answer;
}

export type AgentEvent = { type: 'hello'; agent: string; version: number } | AnswerEvent;

/** What pages receive. They refetch state on "change". */
export type PageEvent =
  | { type: 'change'; card: string }
  | { type: 'presence'; agent: string; online: boolean }
  | { type: 'code' }
  | { type: 'beat'; at: number };

export interface NewCard {
  id?: string;
  agent: string;
  kind?: CardKind;
  title: string;
  text?: string;
  recommendation?: string;
  body?: string;
  options?: Option[];
  multiple?: boolean;
  questions?: AskQuestion[];
  screen?: string;
  priority?: Priority;
  origin?: Origin;
  tags?: Record<string, string>;
  follows?: string;
  deliver?: 'stream' | 'none';
}
