// The message model, version 1. SPEC.md describes each field and rule.

export const PROTOCOL_VERSION = 1;

/** The card tag limit: a card and an agent's default tags share it. */
export const MAX_TAGS = 10;
export const MAX_TAG_CHARS = 100;

/** The id of a priority level. The defaults are now, soon and later. */
export type Priority = string;
/** `secret` is a card an older inbox stored. The inbox refuses a new one: a body asks for a secret with the secret widget. */
export type CardKind = 'ask' | 'blocked' | 'system' | 'secret';
export type CloseKind = 'retracted' | 'self-answered' | 'answered-in-terminal' | 'resolved' | 'expired' | 'returned' | 'dismissed';
export type CardState = 'in-triage' | 'held' | 'open' | 'orphaned' | 'answered' | 'delivered' | 'read' | 'closed';
export type Delivery = 'default' | 'steer' | 'followUp' | 'force';
export type Role = 'owner' | 'agent' | 'extension';

export interface Option {
  id: string;
  label: string;
  description?: string;
  /** The option the agent recommends. The page tags it and shows the card's recommendation inside it. One at most, unless the card takes `multiple`. */
  recommended?: boolean;
}

/** One question of a card that asks several, as card_post takes it and as Claude Code's AskUserQuestion tool sends it. */
export interface AskQuestion {
  question: string;
  header?: string;
  /** Markdown context for this question alone, drawn between the question and its options. */
  text?: string;
  /** The choices, each picked by its label. A question without options takes a free-text answer. */
  options?: { label: string; description?: string; recommended?: boolean }[];
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
  /** On a dismissal: what the person had entered on the card, recorded with the time, even when empty.
   * The owner reads it; publicCard leaves it out for agents. */
  draft?: Draft;
}

/** The form values and comment a person leaves on a card they dismiss. */
export interface Draft {
  values: Record<string, unknown>;
  comment: string;
  at: number;
}

/** A secret the page encrypted for one agent. SPEC.md describes the format. */
export interface Sealed {
  alg: string;
  key: string;
  iv: string;
  data: string;
}

/** What a secret card that an older inbox stored asks for. */
export interface SecretRequest {
  /** The name the agent uses for the value, such as OLLAMA_API_KEY. */
  name: string;
  /** The RSA-OAEP public key the page seals the value with. */
  publicKey: JsonWebKey;
}

/** A sentence the inbox types into a herdr pane as the person's own message, once the person approves it on the card. */
export interface Approval {
  /** A herdr pane id, such as w6P:p2. */
  pane: string;
  /** The exact message to send. */
  text: string;
  label?: string;
  /** Set by the inbox from herdr when the card is posted, never by the agent. */
  place?: ApprovalPlace;
}

/** What herdr says about a pane: its agent, the session title, and the tab and workspace labels. */
export interface ApprovalPlace {
  agent?: string;
  title?: string;
  tab?: string;
  workspace?: string;
}

/** What became of one approval: sent, refused with the reason, or on its way. null for an approval the person left off. */
export type ApprovalResult = { sentAt: number } | { error: string } | { sendingAt: number } | null;

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
  /** The color of the raised hand of a card at this level, as #rrggbb. */
  color?: string;
}

export interface TemplateVersion {
  version: number;
  source: string;
  /** The feedback this version answers. */
  feedback?: string;
  /** For a widget: when an agent should place it, as the catalog shows it. */
  when?: string;
  /** For a widget: text for the agent, filled from the person's answer. See src/core/widgets.ts respond. */
  response?: string;
  at: number;
}

export interface Template {
  name: string;
  versions: TemplateVersion[];
  /** A widget every inbox has, such as mermaid. No one can save over it. */
  builtin?: true;
}

export interface Guidance {
  text: string;
  version: number;
  at: number;
}

/** A tag value and how many cards carry it, as GET /v1/guidance counts them. */
export interface TagValueCount {
  value: string;
  count: number;
}

/** A tag key in use with its values, as card_guidance lists them so an agent reuses a value another card set. */
export interface TagCount {
  key: string;
  values: TagValueCount[];
}

/** A default tag an agent keeps in the inbox: its value, and what set it, such as card_tags or YOUR_ATTENTION_TAGS. */
export interface DefaultTag {
  value: string;
  from: string;
}

/** The default tags one agent holds under one token. Every card that agent posts inherits them under its own tags. */
export interface DefaultTags {
  agent: string;
  tags: Record<string, DefaultTag>;
}

/** A default tags write, as card_tags sends it and PUT /v1/tags takes it. The inbox clears first, then merges `tags`,
 * then drops `remove`, so one call shows the result of all three. */
export interface DefaultTagsWrite {
  agent: string;
  tags?: Record<string, string>;
  remove?: string[];
  clear?: boolean;
  /** What sets these tags: card_tags by default, or YOUR_ATTENTION_TAGS from the pi launcher. */
  from?: string;
}

export interface Settings {
  /** Lets cards carry their own HTML and scripts, in a sandboxed frame. */
  allowHtml: boolean;
  /** The queue's grouping: none, priority, agent or tag:<key>. Absent until the owner picks one. */
  groupBy?: string;
  /** The pinned tag values, oldest first, as [key, value] pairs. Absent until the owner pins one. */
  pins?: [string, string][];
}

/** A change the owner makes to the pins: one value in or out, so another device's pin is never overwritten. */
export interface PinChange {
  pinAdd?: [string, string][];
  pinRemove?: [string, string][];
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
  /** On a pasted answer image, the field it was pasted into, such as `comment` or `q0`. */
  field?: string;
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
  /** Sentences the inbox types into herdr panes when the person approves them. The answer carries approval_<i>. */
  approvals?: Approval[];
  /** The questions are also open as a dialog in the agent's terminal, as Claude Code's AskUserQuestion is. An answer on the card closes that dialog. */
  dialog?: boolean;
  /** The terminal screen of a blocked agent. */
  screen?: string;
  /** Only on a secret card that an older inbox stored. */
  secret?: SecretRequest;
  /** The answer fields that take only a sealed value: the names of the SecretInput fields in the body, which the secret widget places. */
  secrets?: string[];
  /** Raw HTML with scripts, shown in a sandboxed frame when the settings allow it. */
  html?: string;
  attachments?: Attachment[];
  /** The template the body came from. */
  template?: { name: string; version: number };
  /** The widgets the body placed, each at the version it used. */
  widgets?: { name: string; version: number }[];
  /** The responses of the widgets the body placed, with the values each was placed with. */
  responses?: { widget: string; version: number; template: string; values: Record<string, unknown> }[];
  /** Set by the inbox in the page's state, never stored: what the page draws for a body stored before the inbox checked
   * bodies, when the page can't draw it whole. `body` draws the statements that parse, then the source from the broken one on. */
  bodyFallback?: { body: string; faults: string[] };
  /** Set by the laptop inbox in GET /v1/cards/<id> for the owner, never stored: the card came from this machine, and the
   * inbox serves the files its text and recommendation name with file: addresses. */
  localFiles?: boolean;
  priority: Priority;
  /** A state label the agent sets, such as "waiting on CI". */
  status?: string;
  /** When the card stops waiting for an answer, in epoch milliseconds. */
  expiresAt?: number;
  /** How much the agent thinks the card matters, from 1 to 5. */
  rating?: number;
  triage?: Triage;
  history?: CardVersion[];
  /** On a system card that proposes new guidance: the text, the agent that proposed it, which receives the answer, and
   * the guidance the proposal starts from, so the card can say when it changed since. `agents` is on cards stored
   * before the page listed the online agents from live presence, and nothing reads it. */
  broadcast?: { text: string; message?: string; agents?: string[]; from?: string; base?: { version: number; text: string } };
  /** On a system card that asks to send an agent's answers to a webhook: the id of that subscription. */
  subscription?: string;
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
  /** When the owner cleared it from the inbox. Search still finds it, and a revision brings it back. */
  archivedAt?: number;
  closed?: Closure;
  /** Agent replies stored before linked follow-ups. Nothing writes one now, and the page shows the old ones in a fold. */
  replies: Reply[];
}

export interface Answer {
  card: string;
  /** The card version the person answered. */
  version: number;
  /** Form values by field name. Every field is optional. */
  values: Record<string, unknown>;
  comment: string;
  /** Images the person pasted into the answer. The bytes are at GET /v1/attachments/<id>. */
  images?: Attachment[];
  /** For each of the card's approvals, by index, what the inbox did with it. */
  approvalResults?: ApprovalResult[];
  /** The card's widget responses, filled from this answer. */
  responses?: string[];
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
  /** An owner token kept on a machine, such as the laptop's owner-token file or a paired client, which acts without the PIN. A token that can travel as a link or a cookie never has it. */
  pinExempt?: boolean;
}

/** What a client asks of the inbox on a system card. */
export type SystemRequest =
  | { type: 'subscribe'; webhook: { url: string; headers?: Record<string, string> }; events?: 'answer'[] }
  | { type: 'unsubscribe' };

/** A webhook that receives the answers to one agent's cards, for the token that asked. SPEC.md, "Answer webhooks". */
export interface Subscription {
  id: string;
  agent: string;
  /** The id of the token that asked. Never sent to clients. */
  token: string;
  url: string;
  /** Sent with each call. The values are never sent to a client. */
  headers: Record<string, string>;
  events: 'answer'[];
  /** Keys the x-your-attention-signature header. Returned once, to the client that asked. */
  secret: string;
  status: 'pending' | 'approved';
  createdAt: number;
  approvedAt?: number;
  /** How many answers reached the webhook. */
  delivered: number;
  lastError?: { at: number; reason: string };
}

/** A subscription as clients read it: the header names, and no secret. */
export type PublicSubscription = Omit<Subscription, 'token' | 'headers' | 'secret'> & { headers: string[]; waiting: number };

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
  /** The agent's session discards channel notifications, because it started without the development-channels flag
   * that turns them on, so an answer pushed there never reaches it. Set by a connection that knows. */
  channelOff?: true;
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
  /** `by` names who sent the card back: triage, or the inbox page when it could not draw the card. */
  | { type: 'returned'; id: string; card: Card; reason: string; by?: string };

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
  approvals?: Approval[];
  /** The questions are also open as a dialog in the agent's terminal, as Claude Code's AskUserQuestion is. An answer on the card closes that dialog. */
  dialog?: boolean;
  screen?: string;
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
  /** On a card of kind `system` from a client: what it asks the inbox to do. */
  system?: SystemRequest;
}
