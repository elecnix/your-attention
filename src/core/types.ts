// The message model, version 1. SPEC.md describes each field and rule.

export const PROTOCOL_VERSION = 1;

/** The id of a priority level. The defaults are now, soon and later. */
export type Priority = string;
export type CardKind = 'ask' | 'blocked' | 'system' | 'secret';
export type CloseKind = 'retracted' | 'self-answered' | 'answered-in-terminal' | 'resolved' | 'expired' | 'returned';
export type CardState = 'in-triage' | 'held' | 'open' | 'orphaned' | 'answered' | 'delivered' | 'read' | 'closed';
export type Delivery = 'default' | 'steer' | 'followUp' | 'force';
export type Role = 'owner' | 'agent' | 'extension';

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
  /** The labels of the herdr workspace and tab the pane sat in when the card was posted. */
  herdrWorkspace?: string;
  herdrTab?: string;
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

/** A secret the page encrypted for one agent. SPEC.md describes the format. */
export interface Sealed {
  alg: string;
  key: string;
  iv: string;
  data: string;
}

/** What an agent asks for on a secret card. */
export interface SecretRequest {
  /** The name the agent uses for the value, such as OLLAMA_API_KEY. */
  name: string;
  /** The RSA-OAEP public key the page seals the value with. */
  publicKey: JsonWebKey;
}

/** An earlier version of a card, kept when the agent revises it. */
export interface CardVersion {
  version: number;
  title: string;
  text?: string;
  recommendation?: string;
  body?: string;
  html?: string;
  at: number;
}

/** Where a card stands with the extensions on the card.created hook. */
export interface Triage {
  state: 'pending' | 'passed' | 'held' | 'returned' | 'skipped';
  /** The extension that decided, or that the inbox waited for. */
  by?: string;
  reason?: string;
  deadline?: number;
  policy?: 'fail-open' | 'fail-closed';
  /** The id of the hook call the extensions answer. */
  request?: string;
  /** The extensions that have not answered yet. */
  waiting?: string[];
  at: number;
}

export interface PriorityLevel {
  id: string;
  label: string;
  definition: string;
  /** A rule in the language of src/core/expr.ts. A card it matches takes this level. */
  rule?: string;
}

export interface TemplateVersion {
  version: number;
  source: string;
  /** The feedback this version answers. */
  feedback?: string;
  at: number;
}

export interface Template {
  name: string;
  versions: TemplateVersion[];
}

export interface Guidance {
  text: string;
  version: number;
  at: number;
}

export interface Settings {
  /** Lets cards carry their own HTML and scripts, in a sandboxed frame. */
  allowHtml: boolean;
}

/** A file on a card, such as an image, a PDF or a Markdown document.
 * The bytes are at GET /v1/attachments/<id>, or at an https URL. */
export interface Attachment {
  id?: string;
  url?: string;
  name: string;
  type: string;
  size?: number;
  /** A text description, for images. */
  alt?: string;
}

/** A file as an agent sends it: a data: URL with base64 bytes, or an https URL. */
export interface NewAttachment {
  src: string;
  name?: string;
  alt?: string;
  /** Set by the inbox once the bytes are stored. */
  ref?: Attachment;
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
  secret?: SecretRequest;
  /** Raw HTML with scripts, shown in a sandboxed frame when the settings allow it. */
  html?: string;
  attachments?: Attachment[];
  /** The template the body came from. */
  template?: { name: string; version: number };
  /** The widgets the body placed, each at the version it used. */
  widgets?: { name: string; version: number }[];
  priority: Priority;
  /** A state label the agent sets, such as "waiting on CI". */
  status?: string;
  /** When the card stops waiting for an answer, in epoch milliseconds. */
  expiresAt?: number;
  /** How much the agent thinks the card matters, from 1 to 5. */
  rating?: number;
  triage?: Triage;
  history?: CardVersion[];
  /** On a system card that proposes new guidance: the text and the agents it would reach. */
  broadcast?: { text: string; agents: string[] };
  origin?: Origin;
  /** The name the agent gives itself, such as "the release agent". The page shows it as written. */
  from?: string;
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
  /** When the owner cleared it from the inbox. Search still finds it, and a revision or a reply brings it back. */
  archivedAt?: number;
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
  /** The agent processes the answer went to, so a restarted process gets an answer its earlier ones never read. */
  deliveredTo?: string[];
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

/** Whether the person is at the inbox, from the pages they have open. Extensions read it to time their decisions. */
export interface PersonPresence {
  /** Pages connected right now. */
  pages: number;
  /** Whether a page is visible on a screen. */
  visible: boolean;
  /** The last keypress, click or scroll on any page, in epoch milliseconds. */
  activeAt: number | null;
  /** The card on the screen of the most recently active visible page. */
  focus: string | null;
  at: number;
}

export interface Presence {
  agent: string;
  online: boolean;
  lastSeen: number;
  /** When the last connection closed. The agent goes offline after a short grace, so a reconnect or the next long-poll keeps it online. */
  leftAt?: number;
}

/** What an agent stream receives for each answer. */
export interface AnswerEvent {
  type: 'answer';
  id: string;
  card: Card;
  answer: Answer;
}

export type AgentEvent =
  | { type: 'hello'; agent: string; version: number; guidance: number }
  | AnswerEvent
  | { type: 'guidance'; id: string; guidance: Guidance }
  | { type: 'returned'; id: string; card: Card; reason: string };

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
  secret?: SecretRequest;
  html?: string;
  attachments?: NewAttachment[];
  /** Fill the body from a template: each {{name}} takes the value in vars. */
  template?: { name: string; version?: number; vars?: Record<string, string> };
  priority?: Priority;
  status?: string;
  expiresAt?: number;
  rating?: number;
  origin?: Origin;
  from?: string;
  tags?: Record<string, string>;
  follows?: string;
  deliver?: 'stream' | 'none';
}
