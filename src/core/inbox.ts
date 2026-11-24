// The inbox: every change to cards, answers, presence and tokens goes through
// this one object. Storage calls are synchronous, so each change completes
// before the next starts. Every change is written to storage before a method
// returns, and memory holds only the open connections.
import { DEFAULT_CARD_DELAYS, delaysFromReminders, delaysProblem, describeDelays, MAX_REMINDERS } from './require-card.ts';
import { newSecret, pairingCode, randomId, sha256 } from './crypto.ts';
import { readShortCode, shortCode } from './sign-in.ts';
import { parse, test as testRule, type Value } from './expr.ts';
import { HOOK_VERSION, HOOKS, deliverWebhook, isHook, postSigned, type ExtensionRegistration, type HookEvent, type HookName, type Verdict, type Webhook } from './hooks.ts';
import { isSealed, sealedFields, secretInputs, withoutSealed } from './sealed.ts';
import { MAX_DIAGRAMS, bodyProblemsMessage, checkDiagrams, diagramMessage, findDiagrams, requireChecked, type CheckedDiagrams, type DiagramCheck } from './diagrams.ts';
import { BUILTIN_WIDGETS, distinctWidgets, expandWidgets, fill, respond, type WidgetSource } from './widgets.ts';
import { PinLock } from './pin.ts';
import { MemoryBlobs, type BlobStore, type Storage } from './storage.ts';
import { cleanTags, SummarizedStorage, type AnswerSummary, type CardSummary, type ClearedCard } from './summary.ts';
import { Usage } from './telemetry.ts';
import { generateVapid, sendPush, b64urlDecode, type Vapid } from './webpush.ts';
import { MAX_PULL_REQUESTS, MAX_TAGS } from './types.ts';
import type {
  AgentEvent, Answer, AnswerEvent, Approval, ApprovalPlace, ApprovalResult, AskQuestion, Broadcast, Card, CardGuidance, CardState, CardVersion, CloseKind, DefaultTag, DefaultTags, DefaultTagsWrite, Delivery, Draft, Guidance, GuidanceEdit, NewCard, Origin, PageEvent, Pairing, Presence,
  Attachment, NewAttachment, Option, PersonPresence, Pin, PinChange, PresenceOrigin, PriorityLevel, PublicSubscription, PullRequest, RequireCardInput, RequireCardSettings, Role, SentCard, Settings, Subscription, TagCount, Template, Token,
  FeedbackFinding, FeedbackVerdict, LateAnswer, TriageFeedback, TriagePushback,
} from './types.ts';

/** A sign-in code as the inbox keeps it in `meta`. A code made before short codes has no `short`. */
interface SignInCode { key: string; short?: string; expiresAt: number }

export class InboxError extends Error {
  readonly status: number;
  /** Seconds until a refused request may succeed, for a 429's retry-after header. */
  readonly retryAfter: number | undefined;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface Caller {
  token: string;
  role: Role;
}

/** The filters a card search or listing takes. Each one is optional, and every filter given must match. */
export interface SearchFilters {
  /** Keep only cards the person answered. */
  answered?: boolean;
  /** Keep only cards in this state. */
  state?: CardState;
  /** Keep only cards that carry every tag listed: a key alone, or a key and a value as `key=value`. */
  tags?: string[];
  /** Keep only cards this agent posted, by its agent id or a part of its session name. */
  agent?: string;
  /** Keep only cards posted or updated at or after this time, in epoch milliseconds. */
  since?: number;
  /** Keep only cards posted or updated at or before this time, in epoch milliseconds. */
  before?: number;
  /** Keep only cards whose text links this card id or URL. */
  links?: string;
  /** The most results to return. A search returns 20 by default, and no call returns more than 100 at a time. */
  limit?: number;
  /** The `nextCursor` of an earlier call, to read the page after it. */
  cursor?: string;
  /** Keep only cards whose agent gave feedback on a triage pushback: any feedback, or one verdict. */
  triageFeedback?: 'any' | FeedbackVerdict;
}

/** One card triage pushed back on, as the owner's export prints it: what triage said, what the agent answered, and how
 * the card ended. */
export interface TriageFeedbackRecord {
  card: string;
  title: string;
  agent: string;
  state: CardState;
  /** answered, passed (triage let a later version through, and it waits for the person), returned (still sent back),
   * or the kind the card closed with, such as expired or retracted. */
  outcome: string;
  pushback: (Omit<TriagePushback, 'feedback'> & { feedback: TriageFeedback | null })[];
  followedBy?: string;
}

/** One matched card, with its answer when it has one, and the state the inbox shows for it. */
export interface SearchResult {
  card: Card;
  answer?: Answer;
  state: CardState;
}

export interface SearchPage {
  results: SearchResult[];
  /** Set when more cards match: pass it as `cursor` to read the next page. */
  nextCursor?: string;
}

/** Every state a card can be in, for a filter that names one. */
const CARD_STATES = new Set<CardState>(['in-triage', 'held', 'open', 'orphaned', 'answered', 'delivered', 'read', 'closed']);
/** The most results one search or listing call returns, so a cursor reads the rest. */
export const MAX_SEARCH_LIMIT = 100;

/** Types an approved sentence into a herdr pane as the person's message, and names a pane's agent and tab. */
export interface ApprovalSender {
  /** Rejects with the reason when it sends nothing, such as a draft in the pane's input box. */
  send(pane: string, text: string): Promise<void>;
  describe?(pane: string): Promise<ApprovalPlace>;
}

/** A herdr pane id, such as w6P:p2. It never starts with a dash, so herdr cannot read it as a flag. */
export const PANE_ID = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
export const MAX_APPROVALS = 5;
export const MAX_APPROVAL_CHARS = 1000;
const MAX_APPROVAL_LABEL_CHARS = 120;

export interface InboxOptions {
  keepPresence?: boolean;
  uploadLimitBytes?: number | undefined;
  storageLimitBytes?: number | undefined;
  attachmentReadsPerDay?: number | undefined;
  /** PBKDF2 iterations for a new PIN hash. The Workers runtime computes at most 100,000. */
  pinIterations?: number | undefined;
  /** Checks each Mermaid diagram before the inbox takes the card. Without it, the inbox takes no card with a diagram. */
  checkDiagram?: DiagramCheck | undefined;
  /** Lists what keeps the page from drawing all of a card body. The inbox refuses a body with any. */
  checkBody?: ((body: string) => string[]) | undefined;
  /** What the page draws for a stored body it can't draw whole, or undefined for one it draws whole. */
  fallbackBody?: ((body: string) => Card['bodyFallback']) | undefined;
  /** The posting client checks diagrams and bodies, and the inbox takes them unchecked, as on the hosted service, whose
   * requests have too little CPU time to parse them. The page reports what it cannot draw, and the card goes back to its agent. */
  clientChecks?: boolean;
  /** The most cards the state shows. A new card past it waits until the person clears answered or closed cards.
   * The hosted inbox sets it, so GET /v1/state fits its CPU time. Without it, the inbox shows every card. */
  shownCardLimit?: number | undefined;
  /** The inbox always counts usage and has no off switch, as on the hosted service. */
  usageAlwaysOn?: boolean;
  /** Types approved sentences into herdr panes. Without it, as on the hosted inbox, the inbox takes no card with approvals. */
  approvals?: ApprovalSender | undefined;
  /** How the inbox calls answer webhooks and push services. The default is the platform's fetch. */
  fetch?: typeof fetch | undefined;
  /** Whether a new card pushes to a device that collapsed these groups. The page's own rule, `notifies` in web/queue.js,
   * which an adapter passes in because the core imports only the core. Without it, every new card pushes to every device. */
  pushRule?: ((state: ReturnType<Inbox['summaryState']>, card: CardSummary, collapsed: ReadonlySet<string>) => boolean) | undefined;
  /** How long a push waits before its retry. Tests pass an instant one. */
  pushWait?: ((ms: number) => Promise<void>) | undefined;
}

/** A device that gets a push for each new card: the browser's push subscription, and the groups its page has collapsed. */
export interface PushDevice {
  /** The endpoint, which names the device. */
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The ids of the groups the device's page collapsed, which the page sends each time they change. */
  collapsed: string[];
  /** The owner token that saved it. Revoking that token removes the device. */
  token: string;
  savedAt: number;
}

/** What the page sends to save a device: the browser's `PushSubscription` as JSON, and its collapsed groups. */
export interface PushInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  collapsed?: string[];
}

const MAX_PUSH_DEVICES = 20;
const MAX_ENDPOINT_CHARS = 2048;
const MAX_COLLAPSED = 100;
/** The notification shows this much of a title. A longer one ends in an ellipsis. */
const PUSH_TITLE_CHARS = 100;

export const SYSTEM_AGENT = 'system';
/** The inbox itself, as the caller of the system cards it posts. */
const INBOX: Caller = { token: '', role: 'owner' };
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 5;
const CLOSE_KINDS = new Set<CloseKind>(['retracted', 'self-answered', 'answered-in-terminal', 'resolved']);
const HISTORY_LIMIT = 20;
/** How many triage pushbacks a card keeps, newest last. With full feedback on each, they stay under about 300 KB, a cap
 * of their own beside the card's, as history has. */
const PUSHBACK_LIMIT = 10;
/** The longest comment on a triage pushback, as long as a close's outcome. */
export const MAX_FEEDBACK_CHARS = 2000;
const MAX_FINDINGS = 20;
const MAX_FINDING_COMMENT_CHARS = 1000;
const MAX_FINDING_QUOTE_CHARS = 300;
const FEEDBACK_VERDICTS = new Set<string>(['agree', 'disagree', 'partly']);
/** How long an agent stays online after its last connection closes, so a reconnect or the next long-poll keeps it online. */
export const PRESENCE_GRACE_MS = 2000;
/** How long the inbox remembers a message id, to apply a message once however many links bring it. */
export const MESSAGE_MEMORY_MS = 24 * 60 * 60 * 1000;
/** How long a message id stays reserved while its first copy is applied. */
export const MESSAGE_RESERVATION_MS = 30_000;
/** An open card whose agent has been offline this long is orphaned. */
export const ORPHAN_MS = 60 * 60 * 1000;
export const DEFAULT_PRIORITIES: PriorityLevel[] = [
  { id: 'now', label: 'Decide now', definition: 'The agent cannot go on without the answer.', color: '#e5484d' },
  { id: 'soon', label: 'Decide soon', definition: 'The agent needs the answer before it finishes.', color: '#c9a100' },
  { id: 'later', label: 'Can wait', definition: 'The answer refines the work later.' },
];
/** The version of `DEFAULT_GUIDANCE`. It moves whenever that text changes, so a client reads the words it has not seen. */
export const DEFAULT_GUIDANCE_VERSION = 5;
export const DEFAULT_GUIDANCE = [
  'On a card, "you" is the person who reads it. Write about yourself in the third person, as "this agent" or the name in `from`, never "I" or "we", so the person always knows who acts.',
  'Write each card so the person can answer it without opening the session.',
  'State the goal, the options you weighed, the evidence, and your recommendation.',
  'Shape the answer options to the question. The person may leave any field empty.',
  'Put each question next to the field that answers it. One question uses options. Two or more questions use questions, each with its own text and options, and never one options list after all the text. The page draws each question as its own section with a comment field. A question that needs a table or a widget beside it uses a form in the body.',
  'Explain each option inside it, in its description: what this agent does if the person picks it, such as "This agent reruns the deploy." Never list the options with their explanations in the text.',
  'Mark the option this agent recommends with recommended: true, and put only the reasons in the recommendation. The page shows them inside that option, so the person reads the pick once.',
  'Never list questions in the text with the answers at the bottom. Write what you will check yourself as statements, not questions.',
  'The page adds a comment box, Send answer and Skip at the bottom of every card. Add no general comment box or send button of your own.',
  'When a card body or HTML asks several questions, give each one its own short comment field beside it, so the person can say why for that question alone.',
  'When a card is about another agent, link its session so the person can go there in one click: [label](https://herdr.invalid/v1/pane/<pane id>), from `herdr agent list`. Link another card with [[card-id]].',
  'Put text the person should copy, such as a command or an approval sentence, in inline code or a fenced block, and the page lets the person copy it with a click.',
  'When an action needs the person\'s own words in a session, post the sentence as an approval on the card instead of asking the person to type it there.',
  'A card title is one line of plain text: no Markdown and no links. Name the thing there, as "PR #93 — an empty list no longer looks like a success". Put the link in `text`, or in a field label in the body: both read inline Markdown.',
  'To follow up on a card, post a new card with `follows: "<card id>"`. The inbox links the two cards both ways, and there is no reply to a card.',
  'Never ask for a secret, such as an API key, in a text field. Place the secret widget in the card body, `key = widget secret {"name": "API_KEY"}`, and card_post seals it for this session.',
  'Search earlier answers before you post, and never ask the same thing twice.',
].join('\n');
export const MAX_ATTACHMENTS = 10;
/** The longest reason or advice an extension's verdict keeps. One triage reason may list the findings of several checks. */
export const MAX_HOOK_TEXT = 4000;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ANSWER_IMAGES = 10;
/** How many card ids `unread` names before it only counts. A command line has a length. */
export const UNREAD_ID_LIMIT = 20;
// The images of one answer share a byte budget, because the route reads a body of 16 MB and base64 costs four thirds:
// ten images of 8 MB each would make a body no route accepts.
export const MAX_ANSWER_IMAGE_BYTES = 10 * 1024 * 1024;
// An answer takes any file: the person attaches what they were asked about. The page shows an image as a thumbnail
// and everything else as a named chip, and a served file that a browser cannot render comes back as a download.
/** Each stored file counts as at least this many bytes toward the upload limit, so tiny files cannot make unlimited blob writes. */
export const MIN_FILE_CHARGE = 64 * 1024;
/** The largest card, as stored, without its files. */
export const MAX_CARD_BYTES = 256 * 1024;
export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_FROM_CHARS = 80;
export const MAX_VERSIONS = 50;
export const MAX_WEBHOOKS = 5;
export const MAX_SUBSCRIPTIONS = 20;
const MAX_WEBHOOK_HEADERS = 10;
/** How long one call to an answer webhook may take. */
export const ANSWER_WEBHOOK_TIMEOUT_MS = 10_000;
/** A call that started this long ago and never finished, such as one a crash cut off, goes again. */
const DELIVERY_LEASE_MS = ANSWER_WEBHOOK_TIMEOUT_MS + 5_000;
/** The first retry of an answer webhook waits this long, and each later one twice as long, up to an hour. */
export const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60 * 60 * 1000;
/** After this long the inbox stops calling a webhook for one answer. The answer still waits for the agent stream. */
export const RETRY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** Headers the inbox sets on each webhook call itself, or that the platform sets. */
const RESERVED_HEADER = /^(content-type|content-length|host|transfer-encoding|connection|x-your-attention-.*)$/i;
/** The pins one inbox keeps: a tag key or value is cut to 100 characters, as in the card's summary, and an agent id
to 80, as a card's agent is. */
export const MAX_PINS = 20;
export const MAX_TAG_CHARS = 100;
export const MAX_AGENT_CHARS = 80;
/** How long a sign-in code from the phone dialog works. */
export const SIGN_IN_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_SIGN_IN_CODES = 5;
/** Wrong short codes the inbox takes in a window before it refuses every short code until the window passes. With
 * five codes alive at once, the most an owner holds, each guess hits one with odds of 5 in 31^8, about 1 in 1.7e11.
 * Ten guesses every 15 minutes is 350,400 a year, so a guesser who never stops gets in with odds of about 2 in a
 * million a year, even if the owner kept five codes alive all year. A person who mistypes gets ten tries. The limit
 * counts for the whole inbox, since a guesser can change address, and the long code in a link has its own 128 bits,
 * so the QR code and a copied link still sign a device in while typed codes wait. */
export const MAX_WRONG_SIGN_IN_CODES = 10;
export const SIGN_IN_GUESS_WINDOW_MS = 15 * 60 * 1000;
const SIGN_IN_GUESSES = 'signin-guesses';
/** The most tag keys GET /v1/guidance lists, and the most values it lists for each key, so a busy inbox stays short. */
export const MAX_TAG_KEYS = 20;
export const MAX_TAG_VALUES = 15;
/** How long a closed pairing request and its card stay before the sweep deletes them. */
export const PAIRING_KEEP_MS = 24 * 60 * 60 * 1000;
/** How long a cleared card, or a card nobody answered, stays after its last change before the purge deletes it. */
export const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Where the purge keeps the files a delete could not remove, so a laptop retries them on its next pass. */
const PENDING_FILE_DELETES = 'pending-file-deletes';
/** The most cards one purge pass deletes, so no alarm does unbounded work. */
export const PURGE_BATCH = 100;
/** The share of the storage limit the purge keeps free, by deleting the oldest of those cards sooner. */
export const STORAGE_HEADROOM = 0.2;
/** How long the sweep keeps the presence row of an agent after it went offline. */
export const PRESENCE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a card the person sent to an agent waits for it. A session that never comes back leaves nothing behind. */
export const SENT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const PATCH_FIELDS = new Set(['title', 'text', 'body', 'html', 'recommendation']);
const DELIVERIES = new Set<Delivery>(['default', 'steer', 'followUp', 'force']);

/** A card's state follows from its closure and its answer. */
export function cardState(card: Pick<Card, 'closed' | 'triage'> | CardSummary, answer: Pick<Answer, 'savedAt' | 'readAt' | 'deliveredAt'> | undefined): CardState {
  // An answer saved after the agent closed the card still goes to the agent.
  if (card.closed && !(answer && answer.savedAt > card.closed.at)) return 'closed';
  if (!answer && card.triage?.state === 'pending') return 'in-triage';
  if (!answer && card.triage?.state === 'held') return 'held';
  if (!answer) return 'open';
  if (answer.readAt) return 'read';
  if (answer.deliveredAt) return 'delivered';
  return 'answered';
}

/** What a card link shows of its target: its state, how it closed, and when the person answered or the card closed.
 * The outcome text of a close and the person's draft stay out, since a link only says which way the card ended. */
export interface LinkOutcome { state: CardState; kind?: CloseKind; at?: number }
export interface LinkedCard { title: string; preview?: string; archivedAt?: number; outcome: LinkOutcome }

export function linkOutcome(card: Pick<Card, 'closed' | 'triage'>, answer: Pick<Answer, 'savedAt' | 'readAt' | 'deliveredAt'> | undefined): LinkOutcome {
  const state = cardState(card, answer);
  if (state === 'closed' && card.closed) return { state, kind: card.closed.kind, at: card.closed.at };
  return answer && state !== 'closed' ? { state, at: answer.savedAt } : { state };
}

/** The agent an answer goes to, or null for none. A guidance card closes as the person answers it, and its answer
 * still goes to the agent that proposed the text. */
function recipient(card: Card, answer: Answer): string | null {
  if (card.kind === 'system' && card.broadcast) return card.broadcast.from && card.token ? card.broadcast.from : null;
  // A rule proposal travels the same way: the person answers it, and the agent that proposed it hears the outcome.
  if (card.kind === 'system' && card.requireCard) return card.requireCard.from && card.token ? card.requireCard.from : null;
  return card.deliver === 'stream' && cardState(card, answer) !== 'closed' ? card.agent : null;
}

/** One answer waiting for its webhook call, keyed by subscription and card, so a new answer replaces one still waiting. */
interface OutboxItem {
  key: string;
  sub: string;
  card: string;
  /** The answer this call carries, by its savedAt. */
  savedAt: number;
  attempts: number;
  firstAt: number;
  /** When the next call is due. While a call runs, the end of its lease. */
  nextAt: number;
  /** A call is running, or a crash cut it off before its lease ended. */
  calling?: true;
}

/** The id of an answer: the same on every webhook call that carries it, and new when the person changes the answer. */
export function answerId(card: string, savedAt: number): string {
  return `${card}@${savedAt}`;
}

type AgentSend = (ev: AgentEvent) => void;
type PageSend = (ev: PageEvent) => void;

/** A token's default tags, by agent id, as the inbox stores them under one `meta` key. */
interface DefaultTagRow {
  token: string;
  agents: Record<string, Record<string, DefaultTag>>;
  at: number;
}

/**
 * The tags a card stores: the agent's default tags under the card's own. A key on the card wins, and a key the card
 * passes with an empty string drops that default for that card alone. Defaults past the tag limit lose, so the card's
 * own tags always fit. Returns the merged tags, and the keys the card took from the defaults.
 */
export function mergeDefaultTags(defaults: Record<string, string>, own: Record<string, string> | undefined): { tags: Record<string, string> | undefined; inherited: string[] } {
  const tags: Record<string, string> = {};
  const inherited: string[] = [];
  for (const [k, value] of Object.entries(defaults)) {
    // A plain object answers `toString` for every key, so the card's own tags are read by their own key only.
    const mine = own !== undefined && Object.hasOwn(own, k) ? own[k] : undefined;
    if (mine === '') continue;
    if (mine !== undefined) { tags[k] = String(mine); continue; }
    tags[k] = value;
    inherited.push(k);
  }
  for (const [k, value] of Object.entries(own ?? {})) {
    // `in` would see `constructor` and `toString` on any object, so a tag by those names would be dropped.
    if (Object.hasOwn(defaults, k) || value === '') continue;
    tags[k] = String(value);
  }
  // The card's own tags come last in insertion order, so the defaults give way at the limit, and a card that names
  // more than the limit is refused rather than cut.
  while (Object.keys(tags).length > MAX_TAGS && inherited.length) delete tags[inherited.pop() as string];
  if (Object.keys(tags).length > MAX_TAGS) throw new InboxError(400, `a card takes at most ${MAX_TAGS} tags, with its agent's defaults`);
  return { tags: Object.keys(tags).length ? tags : undefined, inherited };
}

/** Which client set each tag, kept for the keys a card still carries after a revision. A repost may drop a tag, and
 * its record goes with it. */
function keptTagFrom(from: Record<string, string> | undefined, tags: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!from || !tags) return undefined;
  const kept = Object.entries(from).filter(([k]) => Object.hasOwn(tags, k));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** When a card.created extension last went away, so a reconnecting one screens only the cards that arrived since. */
const extensionAwayKey = (name: string): string => `extension-away:${name}`;

/** Whether a card arrived or moved while the extension was away. A revision keeps the card's creation time and bumps
 * its version, so the update time is what says it changed. Both times count the stamp itself: a card posted in the same
 * millisecond the extension left is one it never saw, and a strict comparison would leave it unchecked for good. */
const movedWhileAway = (card: Card, away: number | undefined): boolean =>
  away !== undefined && (card.createdAt >= away || (card.version > 1 && card.updatedAt >= away));

/** Whether a new card gives the person something to read: prose, a question, choices, a form, a file, an approval, or a
 * template that fills into a body. An agent's card that carries none of these shows a title and nothing under it, so the
 * paths an agent posts through refuse it. */
export const readsSomething = (c: NewCard): boolean =>
  [c.text, c.html, c.recommendation, c.body].some((t) => typeof t === 'string' && t.trim() !== '')
  || c.template !== undefined
  || (c.questions?.length ?? 0) > 0 || (c.options?.length ?? 0) > 0 || (c.attachments?.length ?? 0) > 0 || (c.approvals?.length ?? 0) > 0;

export class Inbox {
  private readonly store: Storage;
  private readonly blobs: BlobStore;
  private readonly uploadLimit: number | undefined;
  private readonly storageLimit: number | undefined;
  private readonly readsPerDay: number | undefined;
  private readonly checkDiagram: DiagramCheck | undefined;
  private readonly checkBody: ((body: string) => string[]) | undefined;
  private readonly fallbackBody: ((body: string) => Card['bodyFallback']) | undefined;
  private readonly clientChecks: boolean;
  private readonly shownCardLimit: number | undefined;
  private readonly now: () => number;
  private readonly approvalSender: ApprovalSender | undefined;
  private readonly agents = new Map<string, Set<AgentSend>>();
  private readonly instances = new WeakMap<AgentSend, string>();
  private readonly pages = new Set<PageSend>();
  /** The pages that need an unlock token, with the one they opened with and how to close them. */
  private readonly guarded = new Map<PageSend, { unlock: string | undefined; close: () => void }>();
  /** What each open page reports about the person, by page id. */
  private readonly viewers = new Map<string, { visible: boolean; activeAt: number | null; focus: string | null }>();
  private readonly extensions = new Map<string, { reg: ExtensionRegistration; token: string; send: (ev: HookEvent) => void }>();
  /** Webhook deliveries and pushes still running, so a platform, a test and a shutdown can wait for them. */
  readonly deliveries = new Set<Promise<unknown>>();
  private readonly fetcher: typeof fetch;
  private readonly pushRule: InboxOptions['pushRule'];
  private readonly pushWait: InboxOptions['pushWait'];
  /** The VAPID key, read or made once. A promise, so two requests that ask at once make one key. */
  private vapid: Promise<Vapid> | undefined;
  /** The usage counts the platform sends once a day, when the person left them on. */
  readonly usage: Usage;
  /** The PIN a browser tab types before it acts as the owner. */
  readonly pin: PinLock;

  /** `keepPresence` is for a platform whose sockets outlive the object, such as a Durable Object that wakes from hibernation.
   * `uploadLimitBytes` caps the bytes of every file this inbox ever stores. Deleting a file gives none back.
   * `storageLimitBytes` caps what the inbox keeps in its storage now. A full inbox takes only writes that free space.
   * `attachmentReadsPerDay` caps how many files the inbox serves in a day. */
  constructor(store: Storage, now: () => number = Date.now, blobs: BlobStore = new MemoryBlobs(), opts: InboxOptions = {}) {
    // Each write to a card or an answer also writes the card's summary, which GET /v1/state reads.
    this.store = new SummarizedStorage(store);
    this.now = now;
    this.blobs = blobs;
    this.uploadLimit = opts.uploadLimitBytes;
    this.storageLimit = opts.storageLimitBytes;
    this.readsPerDay = opts.attachmentReadsPerDay;
    this.checkDiagram = opts.checkDiagram;
    this.checkBody = opts.checkBody;
    this.fallbackBody = opts.fallbackBody;
    this.clientChecks = opts.clientChecks === true;
    this.shownCardLimit = opts.shownCardLimit;
    this.approvalSender = opts.approvals;
    // Workers refuse a fetch called as a method of another object, so the default calls it bare.
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
    this.pushRule = opts.pushRule;
    this.pushWait = opts.pushWait;
    this.usage = new Usage(store, now, { alwaysOn: opts.usageAlwaysOn });
    this.pin = new PinLock(store, now, opts.pinIterations);
    // A page that opened before the PIN changed must unlock again.
    this.pin.onChange(() => this.closeLockedPages());
    markDialogCards(this.store);
    // On a laptop, connections do not survive a restart, so nobody is online at start.
    if (!opts.keepPresence) {
      for (const p of store.list<Presence>('presence')) {
        if (p.online) store.put('presence', p.agent, { ...p, online: false });
      }
    }
  }

  /** Store a token whose secret the deployment chose, such as an owner token set as a Worker secret. */
  async adoptToken(secret: string, name: string, role: Role): Promise<Token> {
    const id = secret.split('.')[0] ?? '';
    if (!/^[0-9a-f]{12}$/.test(id) || !/^[0-9a-f]{12}\.[0-9a-f]{64}$/.test(secret)) throw new InboxError(400, 'a token is 12 hex digits, a dot, and 64 hex digits');
    const token: Token = { id, hash: await sha256(secret), name, role, createdAt: this.now() };
    this.store.put('tokens', id, token);
    return token;
  }

  /** When the platform alarm must next call sweep(), or undefined when nothing waits. */
  nextDeadline(): number | undefined {
    const times: number[] = [];
    for (const p of this.store.list<Presence>('presence')) {
      if (p.online && p.leftAt !== undefined) times.push(p.leftAt + PRESENCE_GRACE_MS);
      else if (!p.online) times.push((p.leftAt ?? p.lastSeen) + PRESENCE_KEEP_MS);
    }
    for (const p of this.store.list<Pairing>('pairings')) {
      times.push(p.status === 'pending' || p.secret ? p.createdAt + PAIRING_TTL_MS : p.createdAt + PAIRING_KEEP_MS);
    }
    for (const c of this.store.list<Card>('cards')) {
      if (c.triage?.state === 'pending' && c.triage.deadline) times.push(c.triage.deadline);
      if (c.expiresAt && !c.closed && !this.store.get('answers', c.id)) times.push(c.expiresAt);
    }
    const oldest = this.purgeQueue()[0];
    if (oldest) times.push(this.needsRoom() ? this.now() : oldest.since + PURGE_AFTER_MS);
    for (const d of this.store.list<OutboxItem>('outbox')) times.push(d.nextAt);
    for (const s of this.store.list<SentCard>('sent')) times.push(s.sentAt + SENT_KEEP_MS);
    return times.length ? Math.min(...times) : undefined;
  }

  // ---- tokens and pairing ----

  /** Create a token and return its secret. The secret is shown once. */
  async createToken(name: string, role: Role, opts: { pinExempt?: boolean } = {}): Promise<{ token: Token; secret: string }> {
    const id = randomId(6);
    const secret = newSecret(id);
    const token: Token = { id, hash: await sha256(secret), name, role, createdAt: this.now(), ...(opts.pinExempt && role === 'owner' ? { pinExempt: true } : {}) };
    this.store.put('tokens', id, token);
    return { token, secret };
  }

  async authenticate(secret: string | null | undefined): Promise<Token | undefined> {
    if (!secret) return undefined;
    const id = secret.split('.')[0] ?? '';
    const token = this.store.get<Token>('tokens', id);
    if (!token) return undefined;
    return (await sha256(secret)) === token.hash ? token : undefined;
  }

  listTokens(): Omit<Token, 'hash'>[] {
    return this.store.list<Token>('tokens').map(({ hash: _hash, ...t }) => t);
  }

  /** Whether a token, by id, still exists: nobody signed it out or revoked it. */
  hasToken(id: string): boolean {
    return !!this.store.get<Token>('tokens', id);
  }

  revokeToken(id: string): void {
    if (!this.store.get('tokens', id)) throw new InboxError(404, 'unknown token');
    this.store.delete('tokens', id);
    this.pin.dropUnlocks(id);
    this.removeSubscriptions((s) => s.token === id, 'The token that asked for this webhook was revoked.');
    for (const d of this.store.list<PushDevice>('pushes')) if (d.token === id) this.store.delete('pushes', d.id);
  }

  /** Let an owner token act without the PIN, such as the laptop's owner-token file, which only this machine's user reads. */
  exemptFromPin(id: string): void {
    const t = this.store.get<Token>('tokens', id);
    if (t && t.role === 'owner' && !t.pinExempt) this.store.put<Token>('tokens', id, { ...t, pinExempt: true });
  }

  /** Whether a caller must unlock with the PIN, and whether it has. Every cookie, and every owner token that can
   * travel as a link, needs the PIN once the inbox has one. `unlock` is the id of the unlock token the caller sent. */
  async pinGate(token: Token, viaCookie: boolean, secret: string | null | undefined): Promise<{ gated: boolean; locked: boolean; unlock?: string }> {
    const gated = token.role === 'owner' && (viaCookie || !token.pinExempt);
    if (!gated) return { gated, locked: false };
    const unlock = await this.pin.verifyUnlock(secret, token.id);
    return { gated, locked: !unlock && this.pin.isSet(), unlock };
  }

  private closeLockedPages(): void {
    if (!this.pin.isSet()) return;
    for (const [send, g] of this.guarded) {
      if (this.pin.live(g.unlock)) continue;
      this.guarded.delete(send);
      g.close();
    }
  }

  /** The owner's page asks for a code that signs one more device in, such as a phone that scans it. */
  createSignInCode(caller: Caller): { code: string; short: string; expiresAt: number } {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner signs a device in');
    const now = this.now();
    const live = this.signInCodes().filter((c) => {
      if (c.expiresAt > now) return true;
      this.store.delete('meta', c.key);
      return false;
    });
    if (live.length >= MAX_SIGN_IN_CODES) throw new InboxError(429, 'too many sign-in codes are waiting; wait five minutes');
    const code = randomId(16);
    // Two live codes never share a short form, so a typed code names one.
    let short = shortCode();
    while (live.some((c) => c.short === short)) short = shortCode();
    const expiresAt = now + SIGN_IN_CODE_TTL_MS;
    this.store.put('meta', `signin:${code}`, { key: `signin:${code}`, short, expiresAt });
    return { code, short, expiresAt };
  }

  /** A device turns a sign-in code into its own owner token: the long code of a link, or the short code a person
   * typed. Each code works once, and using either form ends both. Wrong short codes count toward a limit. */
  async redeemSignInCode(code: string): Promise<{ secret: string }> {
    const now = this.now();
    const text = String(code ?? '').trim();
    const short = /^[0-9a-f]{32}$/.test(text) ? undefined : readShortCode(text);
    let found: SignInCode | undefined;
    if (short !== undefined) {
      const guesses = this.store.get<{ key: string; at: number[] }>('meta', SIGN_IN_GUESSES)?.at.filter((at) => now - at < SIGN_IN_GUESS_WINDOW_MS) ?? [];
      if (guesses.length >= MAX_WRONG_SIGN_IN_CODES) {
        const seconds = Math.max(1, Math.ceil((Math.min(...guesses) + SIGN_IN_GUESS_WINDOW_MS - now) / 1000));
        const minutes = Math.ceil(seconds / 60);
        throw new InboxError(429, `too many wrong sign-in codes: try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or scan the QR code or open the sign-in link, which work meanwhile`, seconds);
      }
      found = this.signInCodes().find((c) => c.short === short && c.expiresAt > now);
      if (!found) this.store.put('meta', SIGN_IN_GUESSES, { key: SIGN_IN_GUESSES, at: [...guesses, now] });
    } else if (/^[0-9a-f]{32}$/.test(text)) {
      found = this.store.get<SignInCode>('meta', `signin:${text}`);
    }
    if (found) this.store.delete('meta', found.key);
    if (!found || found.expiresAt <= now) throw new InboxError(401, 'this sign-in code is not valid or has expired; get a new one from the phone button of a signed-in page');
    const { secret } = await this.createToken(`device signed in ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`, 'owner');
    return { secret };
  }

  private signInCodes(): SignInCode[] {
    return this.store.list<{ key?: unknown; expiresAt?: unknown }>('meta')
      .filter((m): m is SignInCode => typeof m?.key === 'string' && m.key.startsWith('signin:'));
  }

  /** A client asks to pair. The person sees a system card with the code. */
  requestPairing(name: string, role: Role): Pairing {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new InboxError(400, 'name is required');
    if (role !== 'agent' && role !== 'owner' && role !== 'extension') throw new InboxError(400, 'role must be agent, owner or extension');
    const pending = this.store.list<Pairing>('pairings').filter((p) => p.status === 'pending');
    if (pending.length >= MAX_PENDING_PAIRINGS) throw new InboxError(429, 'too many pairing requests are waiting');
    const pairing: Pairing = { id: randomId(8), name: clean, role, code: pairingCode(), status: 'pending', createdAt: this.now() };
    // The request shows as a card, so it needs room before it counts as waiting.
    this.makeRoom(`pair-${pairing.id}`);
    this.store.put('pairings', pairing.id, pairing);
    this.usage.record('pairings');
    this.postCard({ token: '', role: 'owner' }, {
      id: `pair-${pairing.id}`,
      agent: SYSTEM_AGENT,
      kind: 'system',
      title: `Pair ${role === 'owner' ? 'a front-end' : role === 'extension' ? 'an extension' : 'an agent client'}: ${clean}`,
      text: `A client asks for ${role === 'owner' ? 'full access, as a front-end' : role === 'extension' ? 'extension access: it reads every card and can hold or return them' : 'agent access'}. It shows the code ${pairing.code}. Approve only if the client shows the same code.`,
      options: [
        { id: 'approve', label: 'Approve', description: `The client shows ${pairing.code}` },
        { id: 'deny', label: 'Deny' },
      ],
      priority: 'now',
      deliver: 'none',
    });
    return pairing;
  }

  /** The client collects its token. The secret is returned once. */
  collectPairing(id: string): { status: Pairing['status']; token?: string } {
    const p = this.store.get<Pairing>('pairings', id);
    if (!p) throw new InboxError(404, 'unknown pairing');
    if (p.status !== 'approved' || !p.secret) return { status: p.status };
    const { secret, ...rest } = p;
    this.store.put('pairings', id, rest);
    return { status: p.status, token: secret };
  }

  private async resolvePairing(card: Card, answer: Answer): Promise<void> {
    const id = card.id.slice('pair-'.length);
    const p = this.store.get<Pairing>('pairings', id);
    if (!p || p.status !== 'pending') return;
    const choice = [answer.values['choice']].flat()[0];
    if (choice === 'approve') {
      // Mark the request first, so a second answer during the await mints nothing.
      this.store.put<Pairing>('pairings', id, { ...p, status: 'approved' });
      // The person approved this client on an unlocked page, and its token stays on that machine.
      const { secret } = await this.createToken(p.name, p.role, { pinExempt: p.role === 'owner' });
      this.store.put<Pairing>('pairings', id, { ...p, status: 'approved', secret });
      this.closeAs(card, 'resolved', `Paired ${p.name}.`);
    } else {
      this.store.put<Pairing>('pairings', id, { ...p, status: 'denied' });
      this.closeAs(card, 'resolved', `Denied ${p.name}.`);
    }
  }

  // ---- cards ----

  /** `checked` holds what checkCard found for the card's diagrams. A card with a diagram it does not hold is refused.
   * `opts.revise` marks a patch, which edits one field and keeps the tags the card already carries. */
  postCard(caller: Caller, input: NewCard, storedFiles?: Set<string>, checked?: CheckedDiagrams, places?: (Approval['place'] | undefined)[], opts: { revise?: boolean } = {}): Card {
    if (!input || typeof input !== 'object') throw new InboxError(400, 'card must be an object');
    const title = String(input.title ?? '').trim();
    if (!title) throw new InboxError(400, 'title is required');
    const agent = String(input.agent ?? '').trim();
    if (!agent) throw new InboxError(400, 'agent is required');
    if (agent.length > MAX_AGENT_CHARS) throw new InboxError(400, `agent must be at most ${MAX_AGENT_CHARS} characters`);
    if (title.length > 300) throw new InboxError(400, 'title must be at most 300 characters');
    if (agent === SYSTEM_AGENT && caller.token !== '') throw new InboxError(403, 'the system agent is reserved');
    this.makeRoom(input.id);
    const levels = this.priorities();
    const priority = input.priority ?? (levels.some((l) => l.id === 'soon') ? 'soon' : levels[0]?.id ?? 'soon');
    if (!levels.some((l) => l.id === priority)) throw new InboxError(400, `priority must be one of ${levels.map((l) => l.id).join(', ')}`);
    if (input.rating !== undefined && !(Number.isInteger(input.rating) && input.rating >= 1 && input.rating <= 5)) throw new InboxError(400, 'rating must be 1 to 5');
    if (!input.multiple && Array.isArray(input.options) && input.options.filter((o) => o?.recommended === true).length > 1) throw new InboxError(400, 'a card without multiple takes at most one recommended option');
    checkQuestions(input.questions);
    // The pull requests the card is about, as the caller gives them: one object or an array. Stored as given, so a reader
    // sees which shape it has; a repost without the field leaves the card without one, as a repost of its text does.
    const pullRequests = input.pullRequests === undefined ? undefined : checkPullRequests(input.pullRequests);
    const id = input.id ? String(input.id) : randomId(8);
    if (!/^[\w.:-]{1,80}$/.test(id)) throw new InboxError(400, 'id must be 1 to 80 letters, digits, dots, colons, dashes or underscores');

    const kind = input.kind ?? 'ask';
    if (kind === 'system' && caller.token !== '') throw new InboxError(400, 'a system card from a client asks the inbox for something: send system.type subscribe or unsubscribe');
    // A secret card that an older inbox stored still takes revisions. A new one is refused.
    const before = this.store.get<Card>('cards', id);
    if (kind === 'secret' && before?.kind !== 'secret') throw new InboxError(400, 'the secret card kind was removed. Place the secret widget in the card body instead: key = widget secret {"name": "API_KEY"}. The card_post tool fills its public key. A session that started before this change must restart to load that tool');
    const now = this.now();
    if (before && before.token !== caller.token && caller.role !== 'owner') throw new InboxError(403, 'another client owns this card');
    // A card that carries an answer or a draft already names an option by its label. An id derived now would leave
    // that pick pointing at no option, so the card keeps its options as they are.
    const picked = !!this.store.get<Answer>('answers', id) || !!before?.closed?.draft;
    // A revision keeps what herdr answered about a pane it does not change, since only herdr sets a place.
    const approvals = this.cleanApprovals(input.approvals, kind, places)?.map((a, i) => {
      const kept = a.place ?? (before?.approvals?.[i]?.pane === a.pane ? before.approvals[i].place : undefined);
      return kept ? { ...a, place: kept } : a;
    });
    const { body, template, expanded } = this.cardBody(input);
    // The page drops what it cannot read of a body without a word, so the agent hears it here.
    const bodyProblems = body === undefined || !this.checkBody || this.clientChecks ? [] : this.checkBody(String(body));
    if (bodyProblems.length) throw new InboxError(400, bodyProblemsMessage(bodyProblems));
    const secrets = body === undefined ? [] : secretInputs(String(body));
    let widgets = before?.widgets;
    let responses = before?.responses;
    if (expanded) {
      widgets = expanded.used.length ? distinctWidgets(expanded.used) : undefined;
      responses = expanded.responses.length ? expanded.responses : undefined;
    }
    let attachments = before?.attachments;
    if (input.attachments !== undefined) {
      if (!Array.isArray(input.attachments) || input.attachments.length > MAX_ATTACHMENTS) throw new InboxError(400, `a card takes at most ${MAX_ATTACHMENTS} attachments`);
      attachments = input.attachments.map((f, i) => {
        if (!f || typeof f !== 'object') throw new InboxError(400, `attachment ${index(i)}: must be an object with src`);
        if (f.ref) {
          // A reference names a file this inbox stored: one postCardWithFiles just stored, or one the card already has.
          const kept = before?.attachments?.find((a) => a.id !== undefined && a.id === f.ref?.id);
          if (kept) return kept;
          if (f.ref.id && storedFiles?.has(f.ref.id)) return f.ref;
          throw new InboxError(400, `attachment ${index(i)}: ref must name a file this card already has`);
        }
        const src = String(f.src ?? '');
        if (!/^https:\/\//.test(src)) throw new InboxError(400, `attachment ${index(i)}: src must be an https URL, or a data: URL posted through postCardWithFiles`);
        let last: string;
        try { last = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'file'); } catch { throw new InboxError(400, `attachment ${index(i)}: src is not a valid URL`); }
        const name = cleanName(f.name) || last;
        return { url: src, name, type: typeFromName(name), alt: f.alt ? String(f.alt).slice(0, 300) : undefined };
      });
    }
    const history: CardVersion[] = before
      ? [...(before.history ?? []), { version: before.version, title: before.title, text: before.text, recommendation: before.recommendation, body: before.body, html: before.html, at: before.updatedAt }].slice(-HISTORY_LIMIT)
      : [];
    // Every card an agent posts inherits its default tags, under the card's own. The inbox's own system cards keep none.
    const mergedTags = caller.token === '' || kind === 'system' || opts.revise === true
      ? { tags: input.tags }
      : mergeDefaultTags(this.tagValues(caller.token, agent), ownTags(input.tags));
    const card: Card = {
      id,
      agent,
      token: before?.token ?? caller.token,
      kind,
      title,
      text: input.text,
      recommendation: input.recommendation,
      body,
      options: picked ? withKeptOptionIds(input.options, before) : withOptionIds(input.options),
      multiple: input.multiple,
      questions: input.questions,
      approvals,
      dialog: input.dialog === true ? true : undefined,
      screen: input.screen,
      secret: kind === 'secret' ? before?.secret : undefined,
      secrets: secrets.length ? secrets : undefined,
      html: input.html,
      attachments: attachments?.length ? attachments : undefined,
      template: template ?? before?.template,
      widgets,
      responses,
      priority,
      status: input.status ?? before?.status,
      expiresAt: input.expiresAt,
      rating: input.rating,
      triage: before?.triage,
      pushback: before?.pushback,
      history: history.length ? history : undefined,
      broadcast: before?.broadcast,
      pushed: before ? hadReached(before) || undefined : undefined,
      origin: cleanOrigin(input.origin),
      from: input.from === undefined || input.from === null ? undefined : String(input.from).trim().slice(0, MAX_FROM_CHARS) || undefined,
      tags: mergedTags.tags,
      // A revision keeps the record of who set each tag for the keys the card still carries. A client never sends it.
      tagFrom: keptTagFrom(before?.tagFrom, mergedTags.tags),
      pullRequests,
      follows: input.follows ?? before?.follows,
      followedBy: before?.followedBy,
      deliver: input.deliver ?? 'stream',
      version: (before?.version ?? 0) + 1,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
      // A card triage sent back opens again when the agent revises it.
      closed: before?.closed?.kind === 'returned' ? undefined : before?.closed,
      replies: before?.replies ?? [],
    };
    // The inbox's own system cards quote an agent's words, such as proposed guidance, and the page shows a diagram there as its source.
    if (!this.clientChecks && (kind !== 'system' || caller.token !== '')) requireChecked(findDiagrams(card), checked);
    // History and pushback have caps of their own, and the replies of older cards are stored data the card cap leaves out.
    const size = new TextEncoder().encode(JSON.stringify({ ...card, history: undefined, replies: undefined, pushback: undefined })).length;
    if (size > MAX_CARD_BYTES) throw new InboxError(413, `the card is ${size} bytes, over the limit of ${MAX_CARD_BYTES}. Attach large content as a file`);
    // A card no triage hook screens reaches the person at once. An agent's ask or secret card waits for the hook.
    const screened = (kind === 'ask' || kind === 'secret') && caller.token !== '';
    const shown = screened ? { card, first: false } : this.reached(card);
    this.store.put('cards', id, shown.card);
    this.store.index(id, searchText(card));
    if (card.version === 1 && caller.token !== '') {
      this.usage.record('cards');
      this.usage.saw('tokens', caller.token);
    }
    if (card.follows && card.follows !== id) {
      const prev = this.store.get<Card>('cards', card.follows);
      if (prev) {
        this.store.put('cards', prev.id, { ...prev, followedBy: id });
        this.emit({ type: 'change', card: prev.id });
      }
    }
    this.emit({ type: 'change', card: id });
    // Agent cards go through the card.created hook before the person sees them, and push once it lets them through.
    if (screened) return this.requestTriage(card);
    if (shown.first) this.pushNew(shown.card);
    return shown.card;
  }

  /** An inbox with a limit shows at most that many cards, so its state fits the hosted inbox's CPU time. The limit counts
   * the inbox's own cards too, such as pairing requests, which a client without a token can make. A revision always fits. */
  private makeRoom(id: string | undefined): void {
    const limit = this.shownCardLimit;
    if (limit === undefined || (id && this.store.get('cards', String(id)))) return;
    if ((this.store.count?.('summaries') ?? 0) >= limit) {
      throw new InboxError(507, `the inbox shows ${limit} cards, the most it shows. The person must clear answered or closed cards before a new one fits`);
    }
  }

  /** The body a card shows: its template filled, and its widgets placed. */
  private cardBody(input: NewCard): { body: string | undefined; template?: Card['template']; expanded?: ReturnType<typeof expandWidgets> } {
    let body = input.body;
    let template: Card['template'];
    if (input.template) {
      const t = this.getTemplate(String(input.template.name));
      const v = input.template.version === undefined ? t.versions.at(-1) : t.versions.find((x) => x.version === input.template?.version);
      if (!v) throw new InboxError(404, 'unknown template version');
      body = fill(v.source, input.template.vars ?? {});
      template = { name: t.name, version: v.version };
    }
    // An empty body is no body: a client that fills a missing field with "", or an agent that sends body: "", means a
    // card without widgets, and the body checks would otherwise refuse it for a root statement it has no reason to have.
    if (body === undefined || String(body).trim() === '') return { body: undefined, template };
    const expanded = expandWidgets(String(body), (name, version) => this.widgetVersion(name, version));
    return { body: expanded.body, template, expanded };
  }

  /** Parse every diagram the card would show, before the card commits. An await sits here, so the commit reads everything again. */
  private async checkCard(input: NewCard): Promise<CheckedDiagrams> {
    if (this.clientChecks) return new Map();
    return checkDiagrams(findDiagrams({ text: input.text, recommendation: input.recommendation, body: this.cardBody(input).body }), this.checkDiagram);
  }

  /** What this inbox checks itself before it takes a card. A posting client checks the rest, from GET /v1/info. */
  checks(): { diagrams: boolean; body: boolean } {
    return { diagrams: !this.clientChecks && !!this.checkDiagram, body: !this.clientChecks && !!this.checkBody };
  }

  /** The text, recommendation and body a post or a patch would store, after templates and widgets, without storing anything.
   * A client that checks diagrams and bodies itself reads them here. */
  preview(caller: Caller, req: { card?: NewCard; id?: string; edits?: { old: string; new: string }[]; field?: string; pullRequests?: PullRequest | PullRequest[] | null }): { text?: string; recommendation?: string; body?: string } {
    if (caller.role === 'extension') throw new InboxError(403, 'only the client that posts a card can preview it');
    const input = req.id !== undefined ? this.patched(caller, String(req.id), req.edits ?? [], req.field, req.pullRequests).input : req.card;
    if (!input || typeof input !== 'object') throw new InboxError(400, 'send {card} for a post, or {id, edits, field} for a patch');
    return { text: input.text, recommendation: input.recommendation, body: this.cardBody(input).body };
  }

  /** The page could not draw a card it shows: a diagram that mermaid cannot parse, or a body the OpenUI parser reads in part.
   * The card goes back to its agent with the errors, as a laptop inbox would have refused the post. Only the owner reports. */
  drawFault(caller: Caller, id: string, sent: { version?: unknown; renderer?: unknown; diagrams?: unknown; body?: unknown } | null): Card {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the page reports what it cannot draw');
    const report = sent && typeof sent === 'object' ? sent : {};
    const card = this.getCard(id);
    if (card.kind === 'system') throw new InboxError(400, 'a system card shows its diagrams as source');
    if (Number(report.version) !== card.version) throw new InboxError(409, `the card is at version ${card.version}, and the page drew version ${String(report.version)}`);
    if (card.closed || this.store.get<Answer>('answers', id)) return card;
    const renderer = String(report.renderer ?? '').replace(/[^\w.-]/g, '').slice(0, 20) || 'on the page';
    const shown = findDiagrams(card);
    const reported = (Array.isArray(report.diagrams) ? report.diagrams : []).slice(0, MAX_DIAGRAMS) as { source?: unknown; error?: unknown }[];
    // The page names a diagram by its source. One the card does not show is not this card's fault.
    const diagrams = reported.flatMap((d) => {
      const at = shown.find((x) => x.source === d?.source);
      return at ? [diagramMessage(at.where, renderer, String(d.error ?? 'it does not draw').slice(0, 2000), 'the page could not draw it, and the inbox sent the card back')] : [];
    });
    const faults = card.body === undefined || !Array.isArray(report.body) ? [] : report.body.slice(0, 20).map((f) => String(f).slice(0, 1000)).filter(Boolean);
    const reason = [...diagrams, ...(faults.length ? [bodyProblemsMessage(faults, 'so the inbox sent the card back')] : [])].join('\n\n');
    if (!reason) throw new InboxError(400, 'the report names no diagram this card shows, and no fault in its body');
    return this.sendBack(card, reason, 'The inbox page');
  }

  /** Close a card as returned and tell its agent why. `extension` names the triage extension that sent it back. */
  private sendBack(card: Card, reason: string, by: string, extension?: string): Card {
    this.closeAs(card, 'returned', reason);
    this.tellAgent(card, { type: 'returned', id: randomId(6), card: publicCard(card), reason, by, ...(extension ? { extension } : {}) });
    return this.getCard(card.id);
  }

  /** Send an event to the streams of the agent that posted `card`, with the token that posted it. */
  private tellAgent(card: Card, ev: AgentEvent): void {
    for (const [k, subs] of this.agents) {
      if (k === this.key(card.token ?? '', card.agent)) for (const send of subs) send(ev);
    }
  }

  // ---- extensions and hooks ----

  /** An extension dials in for the hooks it names. A second connection with the same name replaces the first. */
  connectExtension(caller: Caller, reg: Partial<ExtensionRegistration>, send: (ev: HookEvent) => void): () => void {
    const entry = { reg: this.checkExtension(caller, reg), token: caller.token, send };
    const name = entry.reg.name;
    this.extensions.set(name, entry);
    // Screen the cards that came in while no extension was there, and nothing older. A first connection
    // screens nothing: those cards are ones the person already had, and a return would close a card they
    // never answered.
    if (entry.reg.hooks.includes('card.created')) {
      const away = this.store.get<{ at?: number }>('meta', extensionAwayKey(name))?.at;
      for (const card of this.store.list<Card>('cards')) {
        if ((card.kind !== 'ask' && card.kind !== 'secret') || card.closed || this.store.get('answers', card.id)) continue;
        const t = card.triage;
        if (t?.state === 'pending' && t.request && t.deadline && t.waiting?.includes(name)) {
          // A call this extension missed while it reconnected.
          send({ type: 'hook', version: HOOK_VERSION, id: t.request, hook: 'card.created', card: publicCard(card), deadline: t.deadline, person: this.person() });
        } else if ((entry.reg.screen === 'open' || movedWhileAway(card, away)) && (!t || t.state === 'skipped' || (t.state === 'pending' && !t.waiting?.length))) this.requestTriage(card, true);
      }
    }
    return () => {
      if (this.extensions.get(name) !== entry) return;
      this.extensions.delete(name);
      this.store.put('meta', extensionAwayKey(name), { key: extensionAwayKey(name), at: this.now() });
    };
  }

  /** Check and complete an extension registration without connecting it. */
  checkExtension(caller: Caller, reg: Partial<ExtensionRegistration>): ExtensionRegistration {
    if (caller.role === 'agent') throw new InboxError(403, 'only an extension or owner token can register hooks');
    const name = String(reg.name ?? '').trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new InboxError(400, 'name must be 1 to 40 letters, digits, dots, dashes or underscores');
    const hooks = (reg.hooks ?? []).map(String);
    if (!hooks.length || !hooks.every(isHook)) throw new InboxError(400, `hooks must name some of ${Object.keys(HOOKS).join(', ')}`);
    const policy = reg.policy === 'fail-closed' ? 'fail-closed' : 'fail-open';
    const screen = reg.screen === undefined ? 'new' : reg.screen;
    if (screen !== 'new' && screen !== 'open') throw new InboxError(400, 'screen must be new or open');
    const asked = Number(reg.timeoutMs);
    const timeoutMs = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : HOOKS['card.created'].defaultTimeoutMs, 1000), 600_000);
    return { name, hooks: hooks as HookName[], policy, timeoutMs, screen };
  }

  /** `rescreen` is for a card that arrived while no extension was there, which a hook that connects later screens again. It is not new, so it never pushes. */
  private requestTriage(card: Card, rescreen = false): Card {
    if (rescreen && !card.pushed && hadReached(card)) card = { ...card, pushed: true };
    const targets = [...this.extensions.values()].filter((e) => e.reg.hooks.includes('card.created'));
    const now = this.now();
    if (!targets.length) {
      // Fail-open when triage is down: the card goes straight to the person, and a returning extension screens it.
      const shown = this.reached({ ...card, triage: { state: 'skipped' as const, reason: 'No triage extension was connected.', at: now } });
      this.store.put('cards', card.id, shown.card);
      if (shown.first) this.pushNew(shown.card);
      return shown.card;
    }
    const request = randomId(8);
    const deadline = now + Math.max(...targets.map((t) => t.reg.timeoutMs));
    const policy = targets.some((t) => t.reg.policy === 'fail-closed') ? 'fail-closed' as const : 'fail-open' as const;
    const next: Card = { ...card, triage: { state: 'pending', by: targets.map((t) => t.reg.name).join(', '), request, waiting: targets.map((t) => t.reg.name), deadline, policy, at: now } };
    this.store.put('cards', card.id, next);
    this.emit({ type: 'change', card: card.id });
    const person = this.person();
    for (const t of targets) t.send({ type: 'hook', version: HOOK_VERSION, id: request, hook: 'card.created', card: publicCard(next), deadline, person });
    return next;
  }

  /** An extension answers a card.created call. A pass may carry advice, which goes to the card's agent. */
  hookVerdict(caller: Caller, request: string, verdict: Verdict, reason: string, advice = '', bypass = false): Card {
    const card = this.store.list<Card>('cards').find((c) => c.triage?.request === request);
    if (!card?.triage) throw new InboxError(404, 'unknown hook call');
    const ext = [...this.extensions.values()].find((e) => e.token === caller.token && card.triage?.waiting?.includes(e.reg.name));
    if (!ext) throw new InboxError(403, 'this hook call does not wait for this extension');
    if (!(HOOKS['card.created'].verdicts as readonly string[]).includes(verdict)) throw new InboxError(400, 'verdict must be pass, hold or return');
    if (card.triage.state !== 'pending') return card;
    const clean = String(reason ?? '').slice(0, MAX_HOOK_TEXT);
    const waiting = (card.triage.waiting ?? []).filter((n) => n !== ext.reg.name);
    const now = this.now();
    if (verdict === 'return') {
      const reason = clean || 'Triage sent the card back.';
      const pushback = [...(card.pushback ?? []), { kind: 'returned' as const, by: ext.reg.name, reason, version: card.version, at: now }].slice(-PUSHBACK_LIMIT);
      this.store.put('cards', card.id, { ...card, pushback, triage: { ...card.triage, state: 'returned', by: ext.reg.name, reason: clean, waiting: [], advice: undefined, bypass: undefined, at: now } });
      return this.sendBack(card, reason, 'Triage', ext.reg.name);
    }
    const tip = verdict === 'pass' ? String(advice ?? '').trim().slice(0, MAX_HOOK_TEXT) : '';
    // Advice waits on the card until every extension has passed it, since another one may still hold it or send it back.
    const { advice: waitingAdvice = [], ...rest } = card.triage;
    const kept = [...waitingAdvice, ...(tip ? [{ by: ext.reg.name, text: tip }] : [])];
    // A bypass belongs to the verdict that reported it, so a later pass over the same card clears it.
    const triage = verdict === 'hold'
      ? { ...rest, state: 'held' as const, by: ext.reg.name, reason: clean, waiting: [], bypass: undefined, at: now }
      : { ...rest, state: waiting.length ? 'pending' as const : 'passed' as const, waiting, reason: clean || card.triage.reason, ...(waiting.length && kept.length ? { advice: kept } : {}), bypass: bypass ? true : undefined, at: now };
    const shown = this.passWithAdvice({ ...card, triage }, triage.state === 'passed' ? kept : []);
    this.emit({ type: 'change', card: card.id });
    if (shown.first) this.pushNew(shown.card);
    return shown.card;
  }

  /** Store a card that triage just decided on, and when it passed, mark it as reaching the person and give its agent the
   * advice of each extension. Advice is pushback too, so the card keeps it beside a return's entries and the agent can
   * give feedback on it. `first` says the card reached the person for the first time, so the caller pushes it. */
  private passWithAdvice(card: Card, advice: { by: string; text: string }[]): { card: Card; first: boolean } {
    const at = this.now();
    const pushback = advice.length ? [...(card.pushback ?? []), ...advice.map((a) => ({ kind: 'advice' as const, by: a.by, reason: a.text, version: card.version, at }))].slice(-PUSHBACK_LIMIT) : card.pushback;
    const withAdvice = { ...card, ...(pushback ? { pushback } : {}) };
    const shown = card.triage?.state === 'passed' ? this.reached(withAdvice) : { card: withAdvice, first: false };
    this.store.put('cards', card.id, shown.card);
    for (const a of advice) this.tellAgent(card, { type: 'advice', id: randomId(6), card: publicCard(shown.card), advice: a.text, by: a.by });
    return shown;
  }

  /** The agent that posted a card says whether triage was right to push back on it. The feedback answers the latest
   * pushback, and a second call on that pushback replaces the first, so each pushback holds one verdict: the agent may
   * change its mind after it revises the card, and a count of verdicts never counts one pushback twice. */
  triageFeedback(caller: Caller, id: string, input: unknown): Card {
    const card = this.getCard(id);
    if (caller.role !== 'agent' || card.token !== caller.token) throw new InboxError(403, 'only the client that posted this card gives feedback on its triage');
    const last = card.pushback?.at(-1);
    if (!last) throw new InboxError(409, `triage has not pushed back on card ${id}, so there is nothing to give feedback on`);
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const verdict = feedbackVerdict(body['verdict'], 'verdict');
    const comment = cappedText(body['comment'], MAX_FEEDBACK_CHARS, 'comment');
    const raw = body['findings'];
    if (raw !== undefined && !Array.isArray(raw)) throw new InboxError(400, 'findings must be a list');
    if (Array.isArray(raw) && raw.length > MAX_FINDINGS) throw new InboxError(400, `feedback takes at most ${MAX_FINDINGS} findings`);
    const findings = (Array.isArray(raw) ? raw : []).map((f, i): FeedbackFinding => {
      const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const at = `finding ${i + 1}`;
      const idx = o['index'];
      if (idx !== undefined && !(Number.isInteger(idx) && (idx as number) >= 1)) throw new InboxError(400, `${at}: index must be a whole number from 1`);
      const quote = cappedText(o['quote'], MAX_FINDING_QUOTE_CHARS, `${at}: quote`);
      if (idx === undefined && !quote) throw new InboxError(400, `${at}: name the finding by its index in the reason, or by a quote from it`);
      const note = cappedText(o['comment'], MAX_FINDING_COMMENT_CHARS, `${at}: comment`);
      return { ...(idx !== undefined ? { index: idx as number } : {}), ...(quote ? { quote } : {}), verdict: feedbackVerdict(o['verdict'], `${at}: verdict`), ...(note ? { comment: note } : {}) };
    });
    const feedback: TriageFeedback = { verdict, ...(comment ? { comment } : {}), ...(findings.length ? { findings } : {}), agent: card.agent, at: this.now() };
    const pushback = [...(card.pushback ?? []).slice(0, -1), { ...last, feedback }];
    const next = { ...card, pushback };
    this.store.put('cards', id, next);
    this.emit({ type: 'change', card: id });
    return next;
  }

  /** Every card triage pushed back on, for the owner to mine: what triage said, what the agent answered, and how the
   * card ended. `filter` keeps the cards with any feedback, or with one verdict. */
  triageFeedbackRecords(caller: Caller, filter?: SearchFilters['triageFeedback']): TriageFeedbackRecord[] {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner exports triage feedback');
    checkFeedbackFilter(filter);
    return this.store.list<Card>('cards')
      .filter((c) => c.pushback?.length && hasFeedback(c, filter))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((c) => {
        const answer = this.store.get<Answer>('answers', c.id);
        const state = this.shownState(c, this.store.get<Presence>('presence', c.agent), answer);
        return {
          card: c.id,
          title: c.title,
          agent: c.agent,
          state,
          outcome: laterOutcome(c, answer),
          pushback: (c.pushback ?? []).map((p) => ({ ...p, feedback: p.feedback ?? null })),
          ...(c.followedBy ? { followedBy: c.followedBy } : {}),
        };
      });
  }

  /** The owner lets a held card through. */
  release(id: string): Card {
    const card = this.getCard(id);
    if (!card.triage || card.triage.state !== 'held') return card;
    const shown = this.reached({ ...card, triage: { ...card.triage, state: 'passed' as const, reason: `Released by you. ${card.triage.reason ?? ''}`.trim(), at: this.now() } });
    this.store.put('cards', id, shown.card);
    this.emit({ type: 'change', card: id });
    if (shown.first) this.pushNew(shown.card);
    return shown.card;
  }

  addWebhook(hook: string, url: string, secret: string): Webhook {
    if (!isHook(hook)) throw new InboxError(400, `hook must be one of ${Object.keys(HOOKS).join(', ')}`);
    if (!/^https:\/\//.test(String(url))) throw new InboxError(400, 'url must be https');
    if (this.webhooks().length >= MAX_WEBHOOKS) throw new InboxError(400, `an inbox takes at most ${MAX_WEBHOOKS} webhooks`);
    const w: Webhook = { id: randomId(6), hook, url: String(url), secret };
    this.store.put('meta', `webhook:${w.id}`, w);
    return w;
  }

  private webhooks(): Webhook[] {
    return this.store.list<unknown>('meta').filter((m): m is Webhook => typeof m === 'object' && m !== null && 'url' in m && 'secret' in m);
  }

  listWebhooks(): Omit<Webhook, 'secret'>[] {
    return this.webhooks().map(({ secret: _s, ...w }) => w);
  }

  deleteWebhook(id: string): void {
    this.store.delete('meta', `webhook:${id}`);
  }

  private observeAnswer(card: Card, answer: Answer): void {
    // A sealed value opens only with the key in its session's memory, so no hook gets it.
    const event: HookEvent = { type: 'hook', version: HOOK_VERSION, id: randomId(8), hook: 'answer.saved', card: publicCard(card), answer: withoutSealed(card, answer) };
    for (const e of this.extensions.values()) if (e.reg.hooks.includes('answer.saved')) e.send(event);
    for (const w of this.webhooks().filter((x) => x.hook === 'answer.saved')) this.track(deliverWebhook(w, event, this.fetcher));
  }

  private track(p: Promise<unknown>): void {
    this.deliveries.add(p);
    void p.then(() => this.deliveries.delete(p), () => this.deliveries.delete(p));
  }

  // ---- web push ----

  /** The inbox's public VAPID key, which a browser passes to `pushManager.subscribe`. The key pair is made on the first ask
   * and kept in the inbox's storage, and the private half never leaves it. */
  pushKey(): Promise<string> {
    return this.vapidKeys().then((v) => v.publicKey);
  }

  private vapidKeys(): Promise<Vapid> {
    // The read runs before the first await, so two callers share one promise and one key.
    this.vapid ??= (async () => {
      const kept = this.store.get<Vapid>('meta', 'vapid');
      if (kept) return kept;
      const made = await generateVapid();
      // Another object over the same storage may have stored a key while this one generated. Read again, with no await before the write.
      const raced = this.store.get<Vapid>('meta', 'vapid');
      if (raced) return raced;
      this.store.put('meta', 'vapid', made);
      return made;
    })().catch((e: unknown) => { this.vapid = undefined; throw e; });
    return this.vapid;
  }

  /** Save a device, or change the groups it collapsed. The endpoint names the device, so a device saved again is one device. */
  savePush(caller: Caller, input: PushInput): void {
    const endpoint = String(input?.endpoint ?? '');
    let url: URL | undefined;
    try { url = new URL(endpoint); } catch { /* reported below */ }
    if (!url || endpoint.length > MAX_ENDPOINT_CHARS) throw new InboxError(400, `endpoint must be the push service's address, at most ${MAX_ENDPOINT_CHARS} characters`);
    if (url.protocol !== 'https:') throw new InboxError(400, 'endpoint must be an https address');
    const p256dh = String(input.keys?.p256dh ?? '');
    const auth = String(input.keys?.auth ?? '');
    const bytes = (text: string): Uint8Array | undefined => {
      // A length that base64url cannot have, such as one more than a multiple of four, makes atob throw.
      if (!/^[\w-]+$/.test(text) || text.length % 4 === 1) return undefined;
      try { return b64urlDecode(text); } catch { return undefined; }
    };
    const point = bytes(p256dh);
    if (point?.length !== 65 || point[0] !== 4) throw new InboxError(400, 'keys.p256dh must be the browser\'s 65-byte P-256 public key, in base64url');
    if (bytes(auth)?.length !== 16) throw new InboxError(400, 'keys.auth must be 16 bytes in base64url');
    const collapsed = input.collapsed ?? [];
    if (!Array.isArray(collapsed) || collapsed.length > MAX_COLLAPSED || collapsed.some((g) => typeof g !== 'string' || g.length > 300)) {
      throw new InboxError(400, `collapsed must list at most ${MAX_COLLAPSED} group ids, as text`);
    }
    const id = endpoint;
    if (!this.store.get('pushes', id) && this.pushCount() >= MAX_PUSH_DEVICES) {
      throw new InboxError(400, `this inbox pushes to at most ${MAX_PUSH_DEVICES} devices: turn off Notify me on one you no longer use`);
    }
    this.store.put<PushDevice>('pushes', id, { id, endpoint, p256dh, auth, collapsed, token: caller.token, savedAt: this.now() });
  }

  deletePush(endpoint: string): void {
    this.store.delete('pushes', endpoint);
  }

  pushCount(): number {
    return this.store.list<PushDevice>('pushes').length;
  }

  /** The card as stored once it has reached the person, and whether this is the first time. A card pushes once, when it
   * first reaches the person: not while a triage hook screens it, and not again when the agent revises it. The mark is
   * written with the change that shows the card, so it costs no write of its own. */
  private reached(card: Card): { card: Card; first: boolean } {
    return card.pushed ? { card, first: false } : { card: { ...card, pushed: true }, first: true };
  }

  /** A card that would notify the person today also pushes to each saved device. The push runs on, tracked like a webhook,
   * so the platform can wait for it while the post answers at once, and a failed push never touches the card. */
  private pushNew(card: Card): void {
    const devices = this.store.list<PushDevice>('pushes');
    if (!devices.length) return;
    if (card.closed || card.archivedAt) return;
    // The state is read once, and only when a device has collapsed groups for the rule to apply.
    let state: ReturnType<Inbox['summaryState']> | undefined;
    const summary = (): CardSummary | undefined => {
      state ??= this.summaryState();
      return state.cards.find((c) => c.id === card.id);
    };
    const to = devices.filter((d) => {
      if (!this.pushRule || !d.collapsed.length) return true;
      const c = summary();
      return !c || !state || this.pushRule(state, c, new Set(d.collapsed));
    });
    if (!to.length) return;
    const title = [...card.title];
    const text = JSON.stringify({ id: card.id, title: title.length > PUSH_TITLE_CHARS ? `${title.slice(0, PUSH_TITLE_CHARS - 1).join('')}…` : card.title });
    this.track(this.sendPushes(to, new TextEncoder().encode(text)));
  }

  private async sendPushes(to: PushDevice[], payload: Uint8Array): Promise<void> {
    let vapid: Vapid;
    try { vapid = await this.vapidKeys(); } catch { return; }
    await Promise.all(to.map(async (d) => {
      const result = await sendPush(this.fetcher, vapid, d, payload, { ...(this.pushWait ? { wait: this.pushWait } : {}) });
      // The push service forgot this device: the person cleared the site's data, or the browser dropped the subscription.
      if (result.gone) {
        try { this.store.delete('pushes', d.id); } catch { /* the inbox closed while the push ran */ }
      }
    }));
  }

  // ---- answer webhooks ----

  /** A client's system card: a request to send the answers to its cards to a webhook, or to stop. The owner approves each
   * webhook on a system card the inbox posts, and nothing goes out before that. */
  systemRequest(caller: Caller, input: NewCard): ReturnType<Inbox['subscribe']> | { removed: number } {
    const type = input?.system?.type;
    if (type === 'subscribe') return this.subscribe(caller, input);
    if (type !== 'unsubscribe') throw new InboxError(400, 'a system card from a client carries system.type subscribe or unsubscribe');
    const agent = this.requestingAgent(caller, input);
    return { removed: this.removeSubscriptions((s) => s.token === caller.token && s.agent === agent, `The agent ${agent} unsubscribed.`) };
  }

  /** The agent a client's system card speaks for. */
  private requestingAgent(caller: Caller, input: NewCard): string {
    if (caller.role === 'extension') throw new InboxError(403, 'an extension posts no cards');
    const agent = String(input?.agent ?? '').trim();
    if (!agent || agent.length > MAX_AGENT_CHARS) throw new InboxError(400, `agent is required, at most ${MAX_AGENT_CHARS} characters`);
    if (agent === SYSTEM_AGENT) throw new InboxError(403, 'the system agent is reserved');
    return agent;
  }

  /** A subscribe request: the webhook waits, pending, for the owner to approve it on its card. The secret is returned once. */
  subscribe(caller: Caller, input: NewCard): { subscription: PublicSubscription; card: Card; secret: string } {
    const agent = this.requestingAgent(caller, input);
    const req = input.system;
    if (req?.type !== 'subscribe') throw new InboxError(400, 'a subscribe request carries system.type subscribe');
    const mine = (s: Subscription): boolean => s.token === caller.token && s.agent === agent;
    const url = webhookUrl(req.webhook?.url);
    const headers = webhookHeaders(req.webhook?.headers);
    const events = req.events ?? ['answer'];
    if (!Array.isArray(events) || !events.length || events.some((e) => e !== 'answer')) throw new InboxError(400, 'events takes answer, the only event a webhook receives');
    if (this.store.list<Subscription>('subscriptions').filter((s) => !mine(s)).length >= MAX_SUBSCRIPTIONS) {
      throw new InboxError(429, `an inbox takes at most ${MAX_SUBSCRIPTIONS} answer webhooks`);
    }
    const id = randomId(8);
    const cardId = `subscribe-${id}`;
    this.makeRoom(cardId);
    // One webhook for each agent and token: a new request replaces the one before.
    this.removeSubscriptions(mine, 'The agent sent a new request, which replaces this one.');
    const sub: Subscription = { id, agent, token: caller.token, url, headers, events: ['answer'], secret: randomId(24), status: 'pending', createdAt: this.now(), delivered: 0 };
    this.store.put('subscriptions', id, sub);
    const host = new URL(url).host;
    // The card is Markdown, so the agent's words go in code spans, which show them as typed.
    const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;
    const names = Object.keys(headers).map(code);
    this.postCard(INBOX, {
      id: cardId, agent: SYSTEM_AGENT, kind: 'system', deliver: 'none', priority: this.priorities()[0]?.id,
      title: `Send the answers for ${agent} to a webhook?`,
      text: `The agent ${code(agent)} asks the inbox to send each answer you give to its cards to ${code(url)}${names.length ? `, with the header${names.length === 1 ? '' : 's'} ${names.join(', ')}` : ''}. Whoever runs ${host} then reads those answers. Approve only if you know that address.`,
      options: [
        { id: 'approve', label: 'Approve', description: `The inbox sends each answer to the cards of ${code(agent)} to ${host}.` },
        { id: 'deny', label: 'Deny', description: 'Nothing goes out. To stop a webhook you approved, change your answer to this.' },
      ],
    });
    const card = { ...this.getCard(cardId), ...this.requester(agent, input.origin), subscription: id };
    this.store.put('cards', cardId, card);
    return { subscription: this.publicSubscription(sub), card: publicCard(card), secret: sub.secret };
  }

  private resolveSubscription(card: Card, answer: Answer): void {
    const sub = this.store.get<Subscription>('subscriptions', card.subscription ?? '');
    // The webhook went before this answer, so the card keeps the outcome it closed with.
    if (!sub) { this.closeAs(card, 'resolved', card.closed?.outcome ?? 'This webhook is gone.'); return; }
    const host = new URL(sub.url).host;
    if ([answer.values['choice']].flat()[0] === 'approve') {
      this.store.put<Subscription>('subscriptions', sub.id, { ...sub, status: 'approved', approvedAt: sub.approvedAt ?? this.now() });
      this.closeAs(card, 'resolved', `Sending the answers for ${sub.agent} to ${host}. To stop, change your answer to Deny.`);
      return;
    }
    this.removeSubscriptions((s) => s.id === sub.id, sub.status === 'approved' ? `Stopped: no more answers for ${sub.agent} go to ${host}.` : `Denied: nothing goes to ${host}.`);
  }

  /** Remove the webhooks that match, with the calls still waiting, and close the card of each with the outcome. */
  private removeSubscriptions(match: (s: Subscription) => boolean, outcome: string): number {
    const gone = this.store.list<Subscription>('subscriptions').filter(match);
    for (const s of gone) {
      this.store.delete('subscriptions', s.id);
      for (const d of this.store.list<OutboxItem>('outbox')) if (d.sub === s.id) this.store.delete('outbox', d.key);
      const card = this.store.get<Card>('cards', `subscribe-${s.id}`);
      if (card) this.closeAs(card, 'resolved', outcome);
    }
    return gone.length;
  }

  /** The owner removes any webhook, and a client the ones it asked for. */
  deleteSubscription(caller: Caller, id: string): void {
    const sub = this.store.get<Subscription>('subscriptions', id);
    if (!sub) throw new InboxError(404, 'unknown subscription');
    if (caller.role !== 'owner' && sub.token !== caller.token) throw new InboxError(403, 'another client owns this subscription');
    this.removeSubscriptions((s) => s.id === id, sub.token === caller.token ? `The agent ${sub.agent} unsubscribed.` : 'You removed this webhook.');
  }

  /** Every webhook for the owner, and its own for any other client. */
  listSubscriptions(caller: Caller): PublicSubscription[] {
    if (caller.role === 'extension') throw new InboxError(403, 'an extension reads no webhooks');
    return this.store.list<Subscription>('subscriptions').filter((s) => caller.role === 'owner' || s.token === caller.token).map((s) => this.publicSubscription(s));
  }

  private publicSubscription(s: Subscription): PublicSubscription {
    const { token: _t, secret: _s, headers, ...rest } = s;
    return { ...rest, headers: Object.keys(headers), waiting: this.store.list<OutboxItem>('outbox').filter((d) => d.sub === s.id).length };
  }

  /** Queue the answer for the webhook of its card's agent and token, and call it now. */
  private queueAnswer(card: Card, answer: Answer): void {
    if (card.deliver !== 'stream') return;
    const sub = this.store.list<Subscription>('subscriptions').find((s) => s.status === 'approved' && s.token === (card.token ?? '') && s.agent === card.agent);
    if (!sub) return;
    const now = this.now();
    const key = `${sub.id}:${card.id}`;
    this.store.put<OutboxItem>('outbox', key, { key, sub: sub.id, card: card.id, savedAt: answer.savedAt, attempts: 0, firstAt: now, nextAt: now });
    this.track(this.deliverAnswers());
  }

  /** Call the webhook of each answer that is due. An answer calls it at once, and the platform alarm calls it after sweep()
   * for each retry. Each call carries the agent stream's answer event, with the answer's id. */
  async deliverAnswers(): Promise<void> {
    const now = this.now();
    const calls: Promise<void>[] = [];
    for (const item of this.store.list<OutboxItem>('outbox')) {
      if (item.nextAt > now) continue;
      const sub = this.store.get<Subscription>('subscriptions', item.sub);
      const card = this.store.get<Card>('cards', item.card);
      const answer = this.store.get<Answer>('answers', item.card);
      // The card went to another agent, the person changed the answer, or the agent read it already.
      if (!sub || sub.status !== 'approved' || !card || card.agent !== sub.agent || (card.token ?? '') !== sub.token || !answer || answer.savedAt !== item.savedAt || answer.readAt) {
        this.store.delete('outbox', item.key);
        continue;
      }
      // Hold the call before the await, so a second run does not make it again. A call that a crash cut off goes after the lease.
      this.store.put<OutboxItem>('outbox', item.key, { ...item, nextAt: now + DELIVERY_LEASE_MS, calling: true });
      const id = answerId(card.id, answer.savedAt);
      // A sealed value opens only with the key in its session's memory, so the webhook gets the rest of the answer.
      const ev: AnswerEvent = { type: 'answer', id, card: publicCard(card), answer: withoutSealed(card, answer) };
      const headers = { ...sub.headers, 'x-your-attention-event': 'answer', 'x-your-attention-delivery': id };
      calls.push(postSigned(sub.url, sub.secret, headers, ev, ANSWER_WEBHOOK_TIMEOUT_MS, this.fetcher).then((r) => this.called(item, r)));
    }
    // A call that fails to record its result, such as on a store that closed, must not stop the alarm's other work.
    await Promise.allSettled(calls);
  }

  /** Record how a webhook call went: a 2xx marks the answer read, and anything else waits for the next retry. */
  private called(item: OutboxItem, r: { ok: boolean; reason?: string }): void {
    const now = this.now();
    const current = this.store.get<OutboxItem>('outbox', item.key);
    const sub = this.store.get<Subscription>('subscriptions', item.sub);
    // The webhook went, or a newer answer took this call's place while it ran and has its own schedule.
    if (!sub || !current || current.savedAt !== item.savedAt) return;
    if (r.ok) {
      this.store.delete('outbox', item.key);
      const { lastError: _e, ...rest } = sub;
      this.store.put<Subscription>('subscriptions', sub.id, { ...rest, delivered: sub.delivered + 1 });
      const answer = this.store.get<Answer>('answers', item.card);
      // The webhook has the answer, as an agent that acknowledges it on its stream.
      if (answer && answer.savedAt === item.savedAt && !answer.readAt) {
        this.store.put<Answer>('answers', item.card, { ...answer, deliveredAt: answer.deliveredAt ?? now, readAt: now });
        this.emit({ type: 'change', card: item.card });
      }
      return;
    }
    const reason = r.reason ?? 'the webhook failed';
    if (now - item.firstAt >= RETRY_GIVE_UP_MS) {
      this.store.delete('outbox', item.key);
      this.store.put<Subscription>('subscriptions', sub.id, { ...sub, lastError: { at: now, reason: `${reason}; the inbox stopped trying after 24 hours` } });
      return;
    }
    const attempts = item.attempts + 1;
    this.store.put<Subscription>('subscriptions', sub.id, { ...sub, lastError: { at: now, reason } });
    const { calling: _c, ...waiting } = current;
    this.store.put<OutboxItem>('outbox', item.key, { ...waiting, attempts, nextAt: now + Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS) });
  }

  getCard(id: string): Card {
    const card = this.store.get<Card>('cards', id);
    if (!card) throw new InboxError(404, 'unknown card');
    return card;
  }

  /** Post a card whose attachments include data: URLs. The bytes go to the blob store first,
   * then the card commits in one synchronous step, and the files it replaced are deleted. */
  async postCardWithFiles(caller: Caller, input: NewCard): Promise<Card> {
    if (!input || typeof input !== 'object') throw new InboxError(400, 'card must be an object');
    // Only herdr names a pane's agent and tab: a place the agent sent is dropped.
    // Only herdr names a pane's agent and tab: the places go around postCard, so an agent cannot supply one.
    const approvals = this.cleanApprovals(input.approvals, input.kind ?? 'ask');
    const places = approvals ? await this.describePanes(approvals) : undefined;
    const checked = await this.checkCard(input);
    const files = input.attachments;
    if (!Array.isArray(files) || !files.some((f) => /^data:/.test(String(f?.src ?? '')))) return this.postCard(caller, input, undefined, checked, places);
    if (files.length > MAX_ATTACHMENTS) throw new InboxError(400, `a card takes at most ${MAX_ATTACHMENTS} attachments`);
    const id = input.id ? String(input.id) : randomId(8);
    // Check the id before it goes into a blob key.
    if (!/^[\w.:-]{1,80}$/.test(id)) throw new InboxError(400, 'id must be 1 to 80 letters, digits, dots, colons, dashes or underscores');
    const before = this.store.get<Card>('cards', id);
    if (before && before.token !== caller.token && caller.role !== 'owner') throw new InboxError(403, 'another client owns this card');
    if (files.some((f) => !f || typeof f !== 'object')) throw new InboxError(400, 'each attachment must be an object with src');
    const decoded = files.map((f, i) => (/^data:/.test(String(f?.src ?? '')) ? decodeDataUrl(i, f) : undefined));
    // Count the bytes before the first await, so two posts at once cannot both fit under the limit.
    const bytes = decoded.reduce((n, d) => n + (d ? Math.max(d.bytes.length, MIN_FILE_CHARGE) : 0), 0);
    const { used, limit } = this.uploads();
    if (limit !== undefined && used + bytes > limit) {
      throw new InboxError(413, `these files are ${bytes} bytes, and this inbox has stored ${used} of its lifetime limit of ${limit} bytes`);
    }
    this.store.put('meta', 'uploaded-bytes', used + bytes);
    const stored: Attachment[] = [];
    const refund = (): Promise<void> => this.refundUploads(stored, bytes);
    // Wait for every put, so a put that fails leaves none of the others behind. Each key is listed before its put starts.
    const settled = await Promise.allSettled(files.map(async (f, i): Promise<NewAttachment> => {
      const d = decoded[i];
      if (!d) return f;
      const key = `${id}.${i}.${randomId(6)}`;
      const name = cleanName(f.name) || `attachment-${i + 1}`;
      const type = attachmentType({ name, type: d.type });
      const ref: Attachment = { id: key, name, type, size: d.bytes.length, alt: f.alt ? String(f.alt).slice(0, 300) : undefined };
      stored.push(ref);
      await this.blobs.put(key, d.bytes, type);
      return { src: '', ref };
    }));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) {
      await refund();
      throw failed.reason;
    }
    const resolved = settled.map((r) => (r as PromiseFulfilledResult<NewAttachment>).value);
    let card: Card;
    let prior: Card | undefined;
    try {
      // Read the card again right before the commit, with no await between: another update may have landed meanwhile.
      prior = this.store.get<Card>('cards', id);
      card = this.postCard(caller, { ...input, id, attachments: resolved }, new Set(stored.map((f) => f.id ?? '')), checked, places);
    } catch (e) {
      await refund();
      throw e;
    }
    const kept = new Set(card.attachments?.map((f) => f.id));
    await Promise.all((prior?.attachments ?? []).filter((f) => f.id && !kept.has(f.id)).map((f) => this.blobs.delete(f.id ?? '')));
    return card;
  }

  /** Whether the inbox keeps more than its storage limit. A full inbox takes only writes that free space. */
  storageFull(): boolean {
    return this.storageLimit !== undefined && (this.store.bytes?.() ?? 0) >= this.storageLimit;
  }

  /** The bytes of files this inbox has stored since it was created, and its lifetime limit, if it has one. */
  uploads(): { used: number; limit: number | undefined } {
    return { used: this.store.get<number>('meta', 'uploaded-bytes') ?? 0, limit: this.uploadLimit };
  }

  /** The bytes of a file, for the owner, an extension, or the client that posted its card. */
  async attachment(caller: Caller, id: string): Promise<{ file: Attachment; bytes: Uint8Array<ArrayBuffer> }> {
    // A key is <card id>.<index>.<random>, and a card id may contain dots.
    const card = this.getCard(id.split('.').slice(0, -2).join('.') || id);
    if (caller.role === 'agent' && card.token !== caller.token) throw new InboxError(403, 'another client owns this card');
    const answer = this.store.get<Answer>('answers', card.id);
    const file = card.attachments?.find((f) => f.id === id)
      ?? [answer, ...(answer?.previous ?? [])].flatMap((a) => a?.images ?? []).find((f) => f.id === id);
    if (!file) throw new InboxError(404, 'unknown attachment');
    // Each client has its own daily budget, so an agent's downloads never use up the owner's. A refused download reads no blob.
    if (this.readsPerDay !== undefined) {
      const key = `reads:${new Date(this.now()).toISOString().slice(0, 10)}:${caller.token}`;
      const n = this.store.get<{ key: string; n: number }>('meta', key)?.n ?? 0;
      if (n >= this.readsPerDay) throw new InboxError(429, `you downloaded ${this.readsPerDay} files from this inbox today`);
      this.store.put('meta', key, { key, n: n + 1 });
    }
    const blob = await this.blobs.get(id);
    // A cloud inbox deletes files after a while, and the card keeps listing them.
    if (!blob) throw new InboxError(410, `${file.name} is no longer stored`);
    return { file, bytes: blob.bytes };
  }

  /** Why the person won't see a revision of this card, when they answered it or it is closed. The page keeps such a card in
   * Sent and never asks again, so the agent hears it with the revision instead. */
  revisionWarning(id: string): string | undefined {
    const card = this.store.get<Card>('cards', id);
    if (!card) return undefined;
    const s = cardState(card, this.store.get<Answer>('answers', id));
    if (s === 'open' || s === 'in-triage' || s === 'held') return undefined;
    return `Card ${id} ${s === 'closed' ? 'is closed' : 'was already answered'}, so this revision stays in the person's Sent list: the person is not notified, and won't answer it again. To ask again, post a new card with follows: "${id}".`;
  }

  /** Edit a card the way a coding agent edits a file: each edit replaces text that occurs exactly once. */
  patchCard(caller: Caller, id: string, edits: { old: string; new: string }[], field?: string, checked?: CheckedDiagrams, pullRequests?: PullRequest | PullRequest[] | null): Card {
    const { card, input } = this.patched(caller, id, edits, field, pullRequests);
    const next = this.postCard(caller, input, undefined, checked, undefined, { revise: true });
    // A patch edits the body the widgets already filled, so the card still shows them and keeps their responses, and any the patch placed.
    if (!card.widgets) return next;
    const responses = [...(card.responses ?? []), ...(next.responses ?? [])];
    const kept = { ...next, widgets: distinctWidgets([...card.widgets, ...(next.widgets ?? [])]), ...(responses.length ? { responses } : {}) };
    this.store.put('cards', kept.id, kept);
    return kept;
  }

  /** patchCard, with the diagrams of the patched card checked first. */
  async patchCardChecked(caller: Caller, id: string, edits: { old: string; new: string }[], field?: string, pullRequests?: PullRequest | PullRequest[] | null): Promise<Card> {
    const checked = await this.checkCard(this.patched(caller, id, edits, field, pullRequests).input);
    return this.patchCard(caller, id, edits, field, checked, pullRequests);
  }

  /** The card a patch would post, and the card it edits. */
  private patched(caller: Caller, id: string, edits: { old: string; new: string }[], field?: string, pullRequests?: PullRequest | PullRequest[] | null): { card: Card; input: NewCard } {
    const card = this.owned(caller, id);
    // pullRequests is its own argument, separate from the text edits: absent keeps the card's, null or an empty array
    // clears it, and one object or a non-empty array replaces it.
    const hasField = pullRequests !== undefined;
    const f = field ?? (card.body !== undefined ? 'body' : card.html !== undefined ? 'html' : 'text');
    if (!PATCH_FIELDS.has(f)) throw new InboxError(400, `field must be one of ${[...PATCH_FIELDS].join(', ')}`);
    if (!hasField && (!Array.isArray(edits) || !edits.length)) throw new InboxError(400, 'edits must be a list of {old, new}');
    const list = Array.isArray(edits) ? edits : [];
    let text = String((card as unknown as Record<string, unknown>)[f] ?? '');
    for (const [i, e] of list.entries()) {
      const old = String(e?.old ?? '');
      // An empty old text fills a field that is empty.
      if (!old && !text) { text = String(e.new ?? ''); continue; }
      // A patch that replaces text with itself changes nothing, so it is a mistake rather than a revision: accepting it
      // bumped the version, told the person their card changed, and made a "did this text survive?" probe look like an
      // edit.
      if (old && String(e.new ?? '') === old) throw new InboxError(400, `edit ${i + 1}: new is identical to old, so it changes nothing`);
      const count = old ? text.split(old).length - 1 : 0;
      if (count !== 1) {
        // A count alone leaves the agent guessing at text it cannot see. Naming the closest stored lines lets it patch
        // from the real text instead of from the payload it remembers sending.
        const near = count === 0 ? nearestLines(text, old) : [];
        const hint = near.length
          ? `; the closest stored lines are ${near.map((l) => JSON.stringify(l)).join(', ')}`
          : count === 0 ? '; no stored line shares a word with it, so read the card and take the text from there' : '';
        throw new InboxError(409, `edit ${i + 1}: the old text occurs ${count} times in ${f}, and it must occur once${hint}`);
      }
      text = text.replace(old, () => String(e.new ?? ''));
    }
    const { token: _t, version: _v, createdAt: _c, updatedAt: _u, closed: _cl, replies: _r, history: _h, triage: _tr, followedBy: _fb, broadcast: _b, template: _tp, attachments: _a, widgets: _w, responses: _rs, ...rest } = card;
    // Absent leaves the card's pullRequests, which rest carries; null or an empty array clears it; anything else replaces it.
    const nextPullRequests = hasField
      ? (pullRequests === null || (Array.isArray(pullRequests) && !pullRequests.length) ? undefined : checkPullRequests(pullRequests))
      : rest.pullRequests;
    return { card, input: { ...rest, [f]: text, pullRequests: nextPullRequests } };
  }

  /** Merge tags into a card that is already posted, so a card that went out without a topic can be found by a search
   * and grouped later. A key with an empty value removes that key. Any agent may call it, and the owner, because a tag
   * only groups and finds a card and never changes what it asks or what the person answers; `patch`, `close` and a
   * repost keep their ownership check. The card records in `tagFrom` which client set each key. */
  tagCard(caller: Caller, id: string, tags: unknown): Card {
    if (caller.role === 'extension') throw new InboxError(403, 'an extension tags no cards');
    const card = this.getCard(id);
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) throw new InboxError(400, 'tags must be an object of tag keys and values');
    const setter = this.store.get<Token>('tokens', caller.token)?.name ?? caller.role;
    const next = new Map(Object.entries(card.tags ?? {}));
    const from = new Map(Object.entries(card.tagFrom ?? {}));
    const added: string[] = [];
    for (const [k, raw] of Object.entries(tags)) {
      if (!k) throw new InboxError(400, 'each tag needs a key');
      if (k.length > MAX_TAG_CHARS) throw new InboxError(400, `tag key ${k.slice(0, 20)}… must be at most ${MAX_TAG_CHARS} characters`);
      const value = String(raw ?? '');
      if (value.length > MAX_TAG_CHARS) throw new InboxError(400, `tag ${k} must be at most ${MAX_TAG_CHARS} characters`);
      if (value === '') {
        next.delete(k);
        from.delete(k);
      } else {
        if (!next.has(k)) added.push(k);
        next.set(k, value);
        from.set(k, setter);
      }
    }
    // The limit reads the tags the card keeps at the end, so one call may remove a key and add another. A card that
    // already carries more than the limit keeps what it has, so a change to one of its keys still goes in.
    if (next.size > MAX_TAGS && added.length) throw new InboxError(400, `tag ${added[added.length - 1]} takes the card past its ${MAX_TAGS} tags`);
    // fromEntries gives a key named like an Object property its own key, so a tag may read `toString`.
    const merged = Object.fromEntries(next);
    const updated: Card = { ...card, tags: next.size ? merged : undefined, tagFrom: from.size ? Object.fromEntries(from) : undefined };
    this.store.put('cards', id, updated);
    // Search reads the card's tags. The answer's comment stays searchable when the card is written again.
    const answer = this.store.get<Answer>('answers', id);
    this.store.index(id, answer ? `${searchText(updated)}\n${answer.comment}` : searchText(updated));
    this.emit({ type: 'change', card: id });
    return updated;
  }

  /** The agent sets a state label on its own card. An empty label clears it. */
  setStatus(caller: Caller, id: string, status: string): Card {
    const card = this.owned(caller, id);
    const clean = String(status ?? '').trim().slice(0, 60);
    const next = { ...card, status: clean || undefined };
    this.store.put('cards', id, next);
    this.emit({ type: 'change', card: id });
    return next;
  }

  // ---- templates ----

  saveTemplate(name: string, source: string, feedback?: string): Template {
    return this.saveVersion('templates', 'template', name, source, feedback);
  }

  /** Templates and widgets keep every version, with the feedback each one answers. */
  private saveVersion(kind: 'templates' | 'widgets', label: string, name: string, source: string, feedback?: string, extra: { when?: string; response?: string } = {}): Template {
    if (!/^[\w.-]{1,60}$/.test(String(name ?? ''))) throw new InboxError(400, `${label} name must be 1 to 60 letters, digits, dots, dashes or underscores`);
    if (!String(source ?? '').trim()) throw new InboxError(400, 'source is required');
    if (String(source).length > MAX_SOURCE_BYTES) throw new InboxError(413, `source must be at most ${MAX_SOURCE_BYTES} characters`);
    const before = this.store.get<Template>(kind, name);
    const versions = before?.versions ?? [];
    if (versions.length >= MAX_VERSIONS) throw new InboxError(400, `${label} ${name} has ${MAX_VERSIONS} versions, the most it keeps. Save it under a new name`);
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && String(v).length > MAX_SOURCE_BYTES) throw new InboxError(413, `${k} must be at most ${MAX_SOURCE_BYTES} characters`);
    const when = String(extra.when ?? '').trim() || undefined;
    const response = String(extra.response ?? '').trim() ? String(extra.response) : undefined;
    const next: Template = { name, versions: [...versions, { version: versions.length + 1, source: String(source), feedback: feedback ? String(feedback) : undefined, ...(when ? { when } : {}), ...(response ? { response } : {}), at: this.now() }] };
    this.store.put(kind, name, next);
    return next;
  }

  // ---- widgets ----

  saveWidget(name: string, source: string, feedback?: string, extra: { when?: string; response?: string } = {}): Template {
    if (!/^\s*root\s*=/m.test(String(source ?? ''))) throw new InboxError(400, 'a widget must define root, the part a card places');
    if (BUILTIN_WIDGETS.some((w) => w.name === name)) throw new InboxError(400, `${name} is a built-in widget: save yours under another name`);
    return this.saveVersion('widgets', 'widget', name, source, feedback, extra);
  }

  /** The widgets an agent can place, each with when to use it and the values it takes, as agents read them in the card guidance. */
  widgetCatalog(): string {
    const lines = this.listWidgets().map((w) => {
      const v = w.versions.at(-1);
      if (!v) return '';
      const values = [...new Set([...v.source.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
      return `- ${w.name}: ${v.when ?? 'No hook: read its source with GET /v1/widgets/' + w.name + ' first.'}${values.length ? ` Its values: ${values.join(', ')}.` : ''}`;
    }).filter(Boolean);
    return lines.length ? `${CATALOG_HEADER}\n${lines.join('\n')}` : '';
  }

  getWidget(name: string): Template {
    const w = BUILTIN_WIDGETS.find((x) => x.name === name) ?? this.store.get<Template>('widgets', name);
    if (!w) throw new InboxError(404, `unknown widget ${name}`);
    return w;
  }

  /** The built-in widgets first, then the saved ones. */
  listWidgets(): Template[] {
    return [...BUILTIN_WIDGETS, ...this.store.list<Template>('widgets').filter((w) => !BUILTIN_WIDGETS.some((b) => b.name === w.name))];
  }

  private widgetVersion(name: string, version?: number): WidgetSource {
    const w = this.getWidget(name);
    const v = version === undefined ? w.versions.at(-1) : w.versions.find((x) => x.version === version);
    if (!v) throw new InboxError(404, `unknown version ${version} of widget ${name}`);
    return { name, version: v.version, source: v.source, ...(v.response ? { response: v.response } : {}) };
  }

  getTemplate(name: string): Template {
    const t = this.store.get<Template>('templates', name);
    if (!t) throw new InboxError(404, 'unknown template');
    return t;
  }

  listTemplates(): Template[] {
    return this.store.list<Template>('templates');
  }

  // ---- settings, priority levels and guidance ----

  settings(): Settings {
    return this.store.get<Settings>('meta', 'settings') ?? { allowHtml: false };
  }

  /** The require-a-card rule as the inbox holds it, defaulted rather than absent. A rule stored before the schedule
   * keeps its count, which reads as the first delays of the default. */
  requireCard(): RequireCardSettings {
    const s = this.settings().requireCard as Partial<RequireCardSettings> | undefined;
    const delays = Array.isArray(s?.delays) ? [...s.delays] : Number.isFinite(s?.reminders) ? delaysFromReminders(Number(s?.reminders)) : [...DEFAULT_CARD_DELAYS];
    return { mode: s?.mode ?? 'off', delays, reminders: delays.length, ...(s?.agents?.length ? { agents: [...s.agents] } : {}) };
  }

  /** Whether this session is asked for a card, and when: the rule, resolved for one agent id. */
  requireCardFor(agent: string): { on: boolean; delays: number[]; reminders: number } {
    const rule = this.requireCard();
    const on = rule.mode === 'all' || (rule.mode === 'agents' && (rule.agents ?? []).includes(agent));
    return { on, delays: rule.delays, reminders: rule.reminders };
  }

  /** Whether this caller reported this agent id on an open stream, the only identity the inbox can check for a session. */
  connectedAs(caller: Caller, agent: string): boolean {
    return this.agents.has(`${caller.token}\n${agent}`);
  }

  /** An agent turns the rule on or off for itself. Its own conduct, so no card and no approval. */
  setRequireCardForAgent(agent: string, enabled: boolean): RequireCardSettings {
    const id = String(agent ?? '').trim();
    if (!id || id.length > 80) throw new InboxError(400, 'a session id of at most 80 characters is required');
    const rule = this.requireCard();
    // A session cannot step out of a rule that names every agent: only the person can, by changing it for all.
    if (rule.mode === 'all') {
      if (enabled) return rule;
      throw new InboxError(400, 'this inbox asks every agent for a card: change the rule for every agent, or post a card anyway');
    }
    const have = new Set(rule.agents ?? []);
    if (enabled) have.add(id); else have.delete(id);
    const agents = [...have];
    const mode: RequireCardSettings['mode'] = agents.length ? 'agents' : 'off';
    return this.putRequireCard({ mode, delays: rule.delays, ...(agents.length ? { agents } : {}) });
  }

  /** Change the rule, then tell every connected agent, which is what spares them a restart. */
  private putRequireCard(next: RequireCardInput): RequireCardSettings {
    const clean = this.checkRequireCard(next);
    this.store.put('meta', 'settings', { ...this.settings(), requireCard: clean });
    this.emit({ type: 'change', card: '' });
    for (const [, subs] of this.agents) for (const send of subs) send({ type: 'settings', id: randomId(6), requireCard: clean });
    return clean;
  }

  /**
   * The schedule a request asks for: `delays` when it names them, else the older `reminders` count, else `fallback`.
   * A request that sends both, such as a client writing back the rule it read, takes `delays`.
   */
  private checkDelays(input: { delays?: unknown; reminders?: unknown }, fallback: readonly number[]): number[] {
    if (input.delays !== undefined) {
      const problem = delaysProblem(input.delays);
      if (problem) throw new InboxError(400, `requireCard.${problem}`);
      return [...(input.delays as number[])];
    }
    if (input.reminders === undefined) return [...fallback];
    // A count is a number or nothing: a string, a boolean or null would read as 0 or 1 and slip past the range check.
    if (typeof input.reminders !== 'number') throw new InboxError(400, 'requireCard.reminders must be a whole number');
    if (!Number.isInteger(input.reminders) || input.reminders < 0 || input.reminders > MAX_REMINDERS) throw new InboxError(400, `requireCard.reminders must be a whole number from 0 to ${MAX_REMINDERS}`);
    return delaysFromReminders(input.reminders);
  }

  private checkRequireCard(input: RequireCardInput): RequireCardSettings {
    const mode = input?.mode;
    if (mode !== 'off' && mode !== 'all' && mode !== 'agents') throw new InboxError(400, 'requireCard.mode must be off, all or agents');
    const delays = this.checkDelays(input, DEFAULT_CARD_DELAYS);
    // A list is what the field takes, so a string or an object is refused rather than mapped over.
    if (input.agents !== undefined && !Array.isArray(input.agents)) throw new InboxError(400, 'requireCard.agents must be a list of agent ids');
    const agents = mode === 'agents' ? [...new Set(((input.agents as string[] | undefined) ?? []).map((a: string) => String(a).trim()).filter(Boolean))] : [];
    if (agents.some((a) => a.length > MAX_AGENT_CHARS)) throw new InboxError(400, `requireCard.agents takes agent ids of at most ${MAX_AGENT_CHARS} characters`);
    if (mode === 'agents' && !agents.length) throw new InboxError(400, 'requireCard.mode agents needs at least one agent; use off instead');
    return { mode, delays, reminders: delays.length, ...(agents.length ? { agents } : {}) };
  }

  /** What one session should do: the rule resolved for it, beside the rule itself, for whoever wants to see it. */
  requireCardView(agent: string): { on: boolean; delays: number[]; reminders: number; rule: RequireCardSettings } {
    return { ...this.requireCardFor(agent), rule: this.requireCard() };
  }

  /**
   * Propose the rule for every agent at once. Holding every session of the inbox to a card is the inbox's own conduct,
   * so it takes the person's approval: an agent that could turn it on for the others would police its neighbours.
   */
  proposeRequireCard(input: { on: boolean; delays?: unknown; reminders?: unknown; by?: { caller: Caller; agent: string; origin?: unknown } }): Card {
    const from = input.by ? String(input.by.agent ?? '').trim() : '';
    if (from.length > MAX_AGENT_CHARS) throw new InboxError(400, `agent must be at most ${MAX_AGENT_CHARS} characters`);
    if (from === SYSTEM_AGENT) throw new InboxError(403, 'the system agent is reserved');
    const delays = this.checkDelays(input, this.requireCard().delays);
    const mode: 'all' | 'off' = input.on ? 'all' : 'off';
    const what = mode === 'all'
      ? delays.length
        ? `Every agent in this inbox would have to hold an open card. An agent with none is asked ${describeDelays(delays)}, counted from when it went inactive.`
        : 'Every agent in this inbox would be under the rule, and its schedule asks no agent at all.'
      : 'No agent in this inbox would be asked for a card.';
    const cardText = `${from ? `The agent ${from}` : 'An agent'} proposes to change the card rule for every agent. ${what} It changes only if you approve it.`;
    // The text and the proposal are measured whole before anything is stored, the way a guidance proposal is.
    const proposal = { mode, delays, reminders: delays.length, ...(from ? { from } : {}) };
    const size = new TextEncoder().encode(JSON.stringify({ text: cardText, requireCard: proposal })).length + 2048;
    if (size > MAX_CARD_BYTES) throw new InboxError(413, `the card would be ${size} bytes, over the limit of ${MAX_CARD_BYTES}`);
    const id = `require-card-${randomId(4)}`;
    this.postCard({ token: '', role: 'owner' }, {
      id, agent: SYSTEM_AGENT, kind: 'system', deliver: 'none', priority: this.priorities()[0]?.id,
      title: mode === 'all' ? 'Hold every agent to a card?' : 'Stop asking every agent for a card?',
      text: cardText,
      options: [{ id: 'approve', label: mode === 'all' ? 'Approve: hold every agent' : 'Approve: stop asking' }, { id: 'reject', label: 'Reject' }],
    });
    const card: Card = { ...this.getCard(id), ...(from && input.by?.caller.token ? { token: input.by.caller.token } : {}), ...this.requester(from, input.by?.origin), requireCard: proposal };
    this.store.put('cards', id, card);
    this.emit({ type: 'change', card: id });
    return card;
  }

  /** Apply or drop a proposed rule, close the card, and tell the agent that proposed it. */
  private resolveRequireCard(card: Card, answer: Answer): void {
    // A proposal that already closed applies nothing, because a later answer to it is not a decision anyone made.
    // The proposer still hears that answer, so a connected stream is not left without what the store already holds.
    if (!card.requireCard || card.closed) {
      if (card.requireCard?.from) this.flush(card.requireCard.from);
      return;
    }
    if ([answer.values['choice']].flat()[0] === 'approve') {
      // A proposal made before the schedule carries only its count.
      const proposed = card.requireCard.delays ?? delaysFromReminders(card.requireCard.reminders);
      const next = this.putRequireCard({ mode: card.requireCard.mode, delays: proposed });
      this.closeAs(card, 'resolved', next.mode === 'all'
        ? `Approved: every agent with no open card is asked for one ${describeDelays(next.delays)}.`
        : 'Approved: no agent is asked for a card.');
    } else this.closeAs(card, 'resolved', 'Rejected: the card rule did not change.');
    if (card.requireCard.from) this.flush(card.requireCard.from);
  }

  setSettings(input: Partial<Omit<Settings, 'requireCard'>> & { requireCard?: RequireCardInput } & PinChange): Settings {
    const next: Settings = { ...this.settings(), ...(typeof input.allowHtml === 'boolean' ? { allowHtml: input.allowHtml } : {}) };
    // The rule goes through the same validation the tool uses, so a settings PUT and an agent's proposal agree.
    if (input.requireCard !== undefined) next.requireCard = this.checkRequireCard(input.requireCard);
    if (input.groupBy !== undefined) next.groupBy = this.checkGroupBy(input.groupBy);
    if (input.pins !== undefined) next.pins = this.checkPins(input.pins);
    // A pin or an unpin travels as its own change, so two devices that pin at the same moment both keep their value.
    if (input.pinAdd !== undefined || input.pinRemove !== undefined) {
      // Two pins are the same pin when they name the same tag and value, or the same agent.
      const same = (a: Pin, b: Pin) => (Array.isArray(a) && Array.isArray(b) ? a[0] === b[0] && a[1] === b[1] : !Array.isArray(a) && !Array.isArray(b) && a.agent === b.agent);
      const add = input.pinAdd === undefined ? [] : this.checkPins(input.pinAdd);
      const remove = input.pinRemove === undefined ? [] : this.checkPins(input.pinRemove);
      const current = next.pins ?? [];
      const kept = current.filter((p) => !remove.some((r) => same(r, p)));
      const merged = [...kept, ...add.filter((a) => !kept.some((k) => same(k, a)))];
      // A pin the inbox cannot keep is refused, so the person hears it rather than losing the value quietly.
      if (merged.length > MAX_PINS) throw new InboxError(400, `pins takes at most ${MAX_PINS}; unpin a value first`);
      next.pins = merged;
    }
    this.store.put('meta', 'settings', next);
    this.emit({ type: 'change', card: '' });
    // A settings write is how the person changes the rule: connected sessions hear it instead of needing a restart.
    if (input.requireCard !== undefined) for (const [, subs] of this.agents) for (const send of subs) send({ type: 'settings', id: randomId(6), requireCard: next.requireCard! });
    return next;
  }

  private checkGroupBy(groupBy: unknown): string {
    const raw = typeof groupBy === 'string' && groupBy.startsWith('tag:') ? groupBy.slice(4) : '';
    const key = raw.trim();
    if (!(groupBy === 'none' || groupBy === 'priority' || groupBy === 'agent' || (key.length >= 1 && key.length <= MAX_TAG_CHARS))) {
      throw new InboxError(400, 'groupBy must be none, priority, agent or tag:<key>');
    }
    // The key is stored the way it is matched, so `tag: topic ` groups the cards tagged `topic`.
    return key && groupBy !== 'none' ? `tag:${key}` : groupBy as string;
  }

  /** Pins reach the queue the page draws, so a tag key and its value, or an agent id, that cannot work is refused rather
   * than stored. A tag pin keeps the [key, value] pair an older inbox stores and an older client sends. */
  private checkPins(pins: unknown): Pin[] {
    if (!Array.isArray(pins) || pins.length > MAX_PINS) throw new InboxError(400, `pins must be a list of at most ${MAX_PINS} pins`);
    return pins.map((pin: unknown, i): Pin => {
      // A pair is a tag pin, the shape every inbox that pinned a value before agent pins existed holds.
      if (Array.isArray(pin)) {
        if (pin.length !== 2) throw new InboxError(400, `pin ${i + 1}: give a tag key and its value, or an agent`);
        const [key, value] = pin.map((side) => (typeof side === 'string' ? side.trim() : ''));
        if (!key || !value) throw new InboxError(400, `pin ${i + 1}: the tag key and its value are both required`);
        if (key.length > MAX_TAG_CHARS || value.length > MAX_TAG_CHARS) throw new InboxError(400, `pin ${i + 1}: the tag key and its value are at most ${MAX_TAG_CHARS} characters`);
        return [key, value];
      }
      // An agent pin names one agent, and the queue matches it against the agent each card carries.
      const agent = pin && typeof pin === 'object' && typeof (pin as { agent?: unknown }).agent === 'string' ? (pin as { agent: string }).agent.trim() : '';
      if (!agent) throw new InboxError(400, `pin ${i + 1}: give a tag key and its value, or an agent id`);
      if (agent.length > MAX_AGENT_CHARS) throw new InboxError(400, `pin ${i + 1}: an agent id is at most ${MAX_AGENT_CHARS} characters`);
      return { agent };
    });
  }

  priorities(): PriorityLevel[] {
    const saved = this.store.get<PriorityLevel[]>('meta', 'priorities');
    if (!saved) return DEFAULT_PRIORITIES;
    // A default level saved without a color keeps its default color.
    return saved.map((l) => (l.color ? l : { ...l, color: DEFAULT_PRIORITIES.find((d) => d.id === l.id)?.color }));
  }

  /** An agent proposes new priority levels. They reorder the whole queue, so the person approves them on a system card. */
  proposePriorities(levels: PriorityLevel[]): Card {
    const clean = this.checkPriorities(levels);
    const id = `priorities-${randomId(4)}`;
    this.postCard({ token: '', role: 'owner' }, {
      id, agent: SYSTEM_AGENT, kind: 'system', deliver: 'none', priority: this.priorities()[0]?.id,
      title: 'Change the priority levels?',
      text: `An agent proposes these levels. They apply to every card in the queue.\n\n${clean.map((l) => `- ${l.label} (${l.id})${l.definition ? `: ${l.definition}` : ''}${l.rule ? `\n  rule: ${l.rule}` : ''}`).join('\n')}`,
      options: [{ id: 'approve', label: 'Apply them' }, { id: 'reject', label: 'Keep the current levels' }],
    });
    this.store.put('meta', `proposal:${id}`, clean);
    return this.getCard(id);
  }

  private resolvePriorityProposal(card: Card, answer: Answer): void {
    const levels = this.store.get<PriorityLevel[]>('meta', `proposal:${card.id}`);
    this.store.delete('meta', `proposal:${card.id}`);
    if (!levels || [answer.values['choice']].flat()[0] !== 'approve') { this.closeAs(card, 'resolved', 'Kept the current priority levels.'); return; }
    this.setPriorities(levels);
    this.closeAs(card, 'resolved', `Applied ${levels.length} priority levels.`);
  }

  setPriorities(levels: PriorityLevel[]): PriorityLevel[] {
    const clean = this.checkPriorities(levels);
    this.store.put('meta', 'priorities', clean);
    this.emit({ type: 'change', card: '' });
    return clean;
  }

  private checkPriorities(levels: PriorityLevel[]): PriorityLevel[] {
    if (!Array.isArray(levels) || !levels.length || levels.length > 10) throw new InboxError(400, 'give 1 to 10 priority levels');
    const seen = new Set<string>();
    const clean = levels.map((l, i) => {
      const id = String(l?.id ?? '');
      if (!/^[\w-]{1,30}$/.test(id) || seen.has(id)) throw new InboxError(400, `level ${i + 1}: id must be unique, 1 to 30 letters, digits, dashes or underscores`);
      seen.add(id);
      const label = String(l.label ?? '').trim();
      if (!label) throw new InboxError(400, `level ${i + 1}: label is required`);
      const rule = l.rule ? String(l.rule) : undefined;
      if (rule) {
        try { parse(rule); } catch (e) { throw new InboxError(400, `level ${i + 1}: ${(e as Error).message}`); }
      }
      const color = l.color ? String(l.color).toLowerCase() : undefined;
      if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new InboxError(400, `level ${i + 1}: color must be #rrggbb`);
      return { id, label, definition: String(l.definition ?? ''), rule, ...(color ? { color } : {}) };
    });
    return clean;
  }

  /** The level a card shows: the first level whose rule matches it, or the level the agent gave. */
  effectivePriority(card: Card | CardSummary, levels = this.priorities(), answer: AnswerSummary | Answer | undefined = this.store.get<Answer>('answers', card.id)): string {
    const scope: Record<string, Value> = {
      kind: card.kind, agent: card.agent, priority: card.priority, status: card.status ?? null, rating: card.rating ?? null,
      tags: card.tags ?? {}, blocked: card.kind === 'blocked', answered: !!answer,
      waitMinutes: Math.floor((this.now() - card.createdAt) / 60000), harness: card.origin?.harness ?? null,
    };
    for (const l of levels) {
      if (!l.rule) continue;
      try { if (testRule(l.rule, scope)) return l.id; } catch { /* stored rules always parse */ }
    }
    return levels.some((l) => l.id === card.priority) ? card.priority : levels[0]?.id ?? card.priority;
  }

  /** The stored guidance, repaired as it is read: an inbox that stored the widget catalog inside its text keeps the
   * text alone from the first read, so every later read gives the same answer and no diff shows the catalog as lines
   * the approval deletes. The repair keeps the version, so no agent hears of it. */
  guidance(): Guidance {
    const stored = this.store.get<Guidance>('meta', 'guidance') ?? { text: DEFAULT_GUIDANCE, version: DEFAULT_GUIDANCE_VERSION, at: 0 };
    const text = guidanceTextOnly(stored.text, this.widgetCatalog());
    if (text === stored.text) return stored;
    const repaired: Guidance = { ...stored, text };
    this.store.put('meta', 'guidance', repaired);
    return repaired;
  }

  /** The guidance as an agent reads it: the text once, then the widget catalog and the tag values in use, each built
   * from what the inbox has now, so neither one is ever stored in the text or printed twice. */
  cardGuidance(): CardGuidance {
    const g = this.guidance();
    const widgets = this.widgetCatalog();
    return { ...g, ...(widgets ? { widgets } : {}), tags: this.tagsInUse() };
  }

  /** The tag keys in use with their values and counts, for GET /v1/guidance and card_guidance, so an agent reuses a
   * value another card set instead of inventing a near miss. It counts the open cards and the cards cleared or closed
   * in the last PURGE_AFTER_MS, and drops the rest, so a value nobody uses anymore leaves the list. Keys sort by their
   * total count, then by key, and values by count, then by value, cut to MAX_TAG_KEYS keys and MAX_TAG_VALUES values
   * each. It reads the summaries the state already reads, and a whole card only for one cleared inside the window. */
  tagsInUse(): TagCount[] {
    const cutoff = this.now() - PURGE_AFTER_MS;
    const counts = new Map<string, Map<string, number>>();
    const count = (tags: Record<string, string> | undefined): void => {
      // A summary written before tags were cleaned still counts the way the print cleans them, so a stored line break
      // can never forge a line in an agent's card_guidance.
      for (const [key, value] of Object.entries(cleanTags(tags) ?? {})) {
        const values = counts.get(key) ?? new Map<string, number>();
        values.set(value, (values.get(value) ?? 0) + 1);
        counts.set(key, values);
      }
    };
    for (const s of this.store.list<CardSummary>('summaries')) {
      // A card that closed before the window still shows until the person clears it, and its tags are no longer in use.
      if (cardState(s, s.answer) === 'closed' && (s.closed?.at ?? 0) < cutoff) continue;
      count(s.tags);
    }
    // A cleared card keeps no summary, so the list reads the card itself, and only while its clear is inside the window.
    for (const c of this.store.list<ClearedCard>('cleared')) {
      if (c.archivedAt < cutoff) continue;
      count(this.store.get<Card>('cards', c.id)?.tags);
    }
    const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return [...counts.entries()]
      .map(([key, values]) => {
        const list = [...values.entries()].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || byName(a.value, b.value));
        return { key, total: list.reduce((n, v) => n + v.count, 0), values: list };
      })
      .sort((a, b) => b.total - a.total || byName(a.key, b.key))
      .slice(0, MAX_TAG_KEYS)
      .map(({ key, values }) => ({ key, values: values.slice(0, MAX_TAG_VALUES) }));
  }

  /** An agent proposes new card guidance. The person approves it, and picks who receives it, on a system card. With `by`,
   * the answer and its comment go to the agent that proposed the text, which may acknowledge it or retract the card.
   * A list of edits is the usual proposal: each `old` occurs exactly once in the guidance, and the card keeps the edits,
   * so it applies them to the guidance as it is at the approval. A string replaces every rule with that text. */
  proposeGuidance(proposal: string | GuidanceEdit[], message: string, by?: { caller: Caller; agent: string; origin?: unknown }): Card {
    const base = this.guidance();
    // Anything but a string is a list of edits, so one edit sent as an object is refused rather than read as a whole text.
    const edits = typeof proposal === 'string' ? undefined : checkGuidanceEdits(proposal);
    // The catalog and the tag lines reach agents beside the guidance text, so a proposal that carries them keeps the
    // words the agent wrote and loses those lines: an agent that pastes a whole card_guidance answer still proposes.
    const clean = edits ? undefined : guidanceTextOnly(String(proposal ?? ''), this.widgetCatalog());
    if (clean === '') throw new InboxError(400, 'a proposal needs the guidance text itself: the widget catalog and the tag lines are added beside it, so a text with only those is empty');
    // Edits are checked against the guidance now, so an agent hears at once which passage it got wrong.
    if (edits && !guidanceTextOnly(editGuidance(base, edits), this.widgetCatalog())) throw new InboxError(400, 'those edits leave the guidance empty: to replace every rule, propose replace_all_with');
    // The person reads the message to decide, so a proposal without one is refused rather than shown unexplained.
    const why = String(message ?? '').trim();
    if (!why) throw new InboxError(400, 'a guidance proposal needs a message: say what changed and why, for the person who approves it');
    if (why.length > 2000) throw new InboxError(400, 'message must be at most 2000 characters');
    const from = by ? String(by.agent ?? '').trim() : '';
    if (from.length > MAX_AGENT_CHARS) throw new InboxError(400, `agent must be at most ${MAX_AGENT_CHARS} characters`);
    if (from === SYSTEM_AGENT) throw new InboxError(403, 'the system agent is reserved');
    const id = `guidance-${randomId(4)}`;
    const who = from ? `The agent ${from}` : 'An agent';
    // The card's text is what a search and a notification read. The page and the terminal client draw the diff instead.
    const cardText = edits
      ? `${who} proposes ${edits.length} edit${edits.length === 1 ? '' : 's'} to the guidance for writing cards. They go out only if you approve them.\n\n${edits.map((e, i) => `Edit ${i + 1} replaces:\n\n${quote(e.old)}\n\nwith:\n\n${quote(e.new)}`).join('\n\n')}`
      : `${who} proposes this guidance for writing cards. It replaces every rule, and goes out only if you approve it.\n\n${clean}`;
    // The card keeps no list of agents: the page lists the online ones from live presence when it draws the card, and
    // an offline agent reads the new version when it reconnects or calls card_guidance.
    const broadcast: Broadcast = { ...(edits ? { edits } : { text: clean }), message: why, ...(from ? { from } : {}), base: { version: base.version, text: base.text } };
    // The stored card has the proposal in its text and in broadcast, and the guidance it starts from, so it is measured
    // whole before anything is stored. The margin covers the card's other fields, which stay under a kilobyte.
    const size = new TextEncoder().encode(JSON.stringify({ text: cardText, broadcast })).length + 2048;
    if (size > MAX_CARD_BYTES) throw new InboxError(413, `the guidance card would be ${size} bytes, over the limit of ${MAX_CARD_BYTES}: propose a shorter text`);
    this.postCard({ token: '', role: 'owner' }, {
      id, agent: SYSTEM_AGENT, kind: 'system', deliver: 'none', priority: this.priorities()[0]?.id,
      title: 'Send new card guidance to agents?',
      text: cardText,
      options: [{ id: 'approve', label: 'Approve and send' }, { id: 'reject', label: 'Reject' }],
    });
    const card: Card = {
      ...this.getCard(id),
      ...(from && by?.caller.token ? { token: by.caller.token } : {}),
      ...this.requester(from, by?.origin),
      broadcast,
    };
    this.store.put('cards', id, card);
    this.emit({ type: 'change', card: id });
    return card;
  }

  /** The agent that asked for a system card, and where it ran: the origin its request carried, else the one its
   * connection reported. The card shows that session the way an agent's own card does. */
  private requester(agent: string, origin: unknown): Pick<Card, 'proposedBy' | 'origin'> {
    if (!agent) return {};
    const where = cleanOrigin(origin) ?? this.store.get<Presence>('presence', agent)?.origin;
    return { proposedBy: agent, ...(where ? { origin: { ...where } } : {}) };
  }

  /** Each open proposal of edits now reads against a new guidance, so its summary gets a new rev and the page fetches
   * the card again rather than drawing the text it derived from the older version. */
  private reshowEditProposals(): void {
    for (const s of this.store.list<CardSummary>('summaries')) {
      if (s.kind !== 'system' || s.closed || !s.id.startsWith('guidance-')) continue;
      const card = this.store.get<Card>('cards', s.id);
      if (!card?.broadcast?.edits) continue;
      this.store.put('cards', card.id, card);
      this.emit({ type: 'change', card: card.id });
    }
  }

  /** A guidance card as a reader sees it. A proposal of edits gets the text those edits make of the guidance stored now,
   * and that guidance as its base, so two proposals from one version each show their own change; an edit whose passage
   * is gone shows no change and says why in `stale`. */
  private shownBroadcast<C extends Card>(card: C): C {
    const b = card.broadcast;
    if (!b?.edits) return card;
    const now = this.guidance();
    const base = { version: now.version, text: now.text };
    try {
      return { ...card, broadcast: { ...b, text: editGuidance(now, b.edits), base } };
    } catch (e) {
      return { ...card, broadcast: { ...b, text: now.text, base, stale: e instanceof Error ? e.message : String(e) } };
    }
  }

  /** Apply or drop the proposed guidance, close the card, and send the answer to the agent that proposed the text. */
  private resolveBroadcast(card: Card, answer: Answer): void {
    if (!card.broadcast) return;
    this.closeAs(card, 'resolved', this.applyBroadcast(card.broadcast, answer));
    if (card.broadcast.from) this.flush(card.broadcast.from);
  }

  private applyBroadcast(broadcast: NonNullable<Card['broadcast']>, answer: Answer): string {
    if ([answer.values['choice']].flat()[0] !== 'approve') return 'Rejected: the guidance did not change.';
    // The ticked agents, or every connected one when the answer names none. Only connected agents get the event.
    const picked = Array.isArray(answer.values['agents']) ? new Set((answer.values['agents'] as unknown[]).map(String)) : undefined;
    // Edits apply to the guidance as it is now, in this same step, so an approval never overwrites a rule that another
    // approval added since the proposal. An edit whose passage is gone applies nothing, and the agent hears which one.
    let edited: string;
    try {
      edited = broadcast.edits ? editGuidance(this.guidance(), broadcast.edits) : String(broadcast.text ?? '');
    } catch (e) {
      return `Not applied: ${e instanceof Error ? e.message : String(e)}. The guidance changed after the proposal, so it did not change now: read it and propose again.`;
    }
    // The card may hold a text an older inbox stored, so the catalog is dropped once more before it becomes the guidance.
    const text = guidanceTextOnly(edited, this.widgetCatalog());
    // A card kept before this change may hold nothing but the catalog or the tag lines, and storing that would leave
    // every agent reading a blank guidance. The approval changes nothing instead, and the card says so.
    if (!text) return 'Rejected: that text was only the widget catalog or the tag lines, so the guidance did not change.';
    const guidance: Guidance = { text, version: this.guidance().version + 1, at: this.now() };
    this.store.put('meta', 'guidance', guidance);
    this.reshowEditProposals();
    let sent = 0;
    for (const [k, subs] of this.agents) {
      const agent = k.slice(k.indexOf('\n') + 1);
      if (picked && !picked.has(agent)) continue;
      for (const send of subs) send({ type: 'guidance', id: randomId(6), guidance });
      sent++;
    }
    return `Sent guidance version ${guidance.version} to ${sent} connected agent${sent === 1 ? '' : 's'}. The others get it when they connect.`;
  }

  /** The title, text preview, clear time and outcome of each card the caller may read, by id, for the card links on screen.
   * A cleared card leaves the state but stays stored until the purge, so its links still name it, and still say whether the
   * person answered it or its agent took it back. Ids it never stored are left out. */
  linkedCards(caller: Caller, ids: string[]): Record<string, LinkedCard> {
    if (ids.length > MAX_LOOKUP) throw new InboxError(400, `name at most ${MAX_LOOKUP} card ids`);
    const out: [string, LinkedCard][] = [];
    for (const id of ids) {
      const card = this.store.get<Card>('cards', id);
      if (!card || (caller.role !== 'owner' && card.token !== caller.token)) continue;
      const outcome = linkOutcome(card, this.store.get<Answer>('answers', id));
      out.push([id, { title: card.title, ...(card.text ? { preview: card.text.slice(0, 300) } : {}), ...(card.archivedAt ? { archivedAt: card.archivedAt } : {}), outcome }]);
    }
    // fromEntries makes every id an own key, even one named like an Object property.
    return Object.fromEntries(out);
  }

  private owned(caller: Caller, id: string): Card {
    const card = this.getCard(id);
    if (caller.role !== 'owner' && card.token !== caller.token) throw new InboxError(403, 'another client owns this card');
    return card;
  }

  private closeAs(card: Card, kind: CloseKind, outcome: string, draft?: Draft): Card {
    const current = this.getCard(card.id);
    // A card closed while triage checks it needs no verdict any more.
    const triage = current.triage?.state === 'pending' ? { ...current.triage, state: 'skipped' as const, waiting: [], reason: 'The card closed before triage answered.' } : current.triage;
    // A draft the person recorded stays with the card, whoever closes it next, so their words are never lost.
    const kept = draft ?? current.closed?.draft;
    const closed: Card = { ...current, triage, closed: { kind, outcome, at: this.now(), ...(kept ? { draft: kept } : {}) } };
    this.store.put('cards', card.id, closed);
    this.emit({ type: 'change', card: card.id });
    return closed;
  }

  /** The agent retracts its card or answers it itself. */
  close(caller: Caller, id: string, kind: CloseKind, outcome: string, ifUnanswered = false): Card {
    const card = this.owned(caller, id);
    if (!CLOSE_KINDS.has(kind)) throw new InboxError(400, 'unknown close kind');
    const answer = this.store.get<Answer>('answers', id);
    if (ifUnanswered && answer) throw new InboxError(409, 'the person already answered this card');
    return this.closeAs(card, kind, String(outcome || '').slice(0, 2000) || 'No outcome given.');
  }

  /** The person dismisses a card: it closes without the agent hearing anything, and the form values and the comment on
   * screen are recorded with the time, even when both are empty. No answer is stored, so no stream receives an event, and
   * a revision the agent sends later is saved but leaves the card in Sent. Only the owner reads the draft. */
  dismiss(caller: Caller, id: string, input: { values?: unknown; comment?: unknown } = {}): Card {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner dismisses a card');
    const card = this.getCard(id);
    if (card.closed) throw new InboxError(409, 'this card is already closed');
    // A secret field holds the secret itself, and a dismissal is not an answer to seal it, so it stays out of the record.
    // The other fields and the comment are the person's own words about the card, so they stay.
    const sealed = sealedFields(card);
    const values = !input.values || typeof input.values !== 'object' || Array.isArray(input.values)
      ? {} : Object.fromEntries(Object.entries(input.values as Record<string, unknown>).filter(([k]) => !sealed.includes(k)));
    return this.closeAs(card, 'dismissed', 'Nothing was sent to the agent.', { values, comment: String(input.comment ?? '').trim(), at: this.now() });
  }

  /** The person takes back a card that triage sent to its agent. The card opens again and reads as never triaged, and
   * the return the extension added goes with it, so the card's chain does not count a return that the person undid. */
  reopen(caller: Caller, id: string): Card {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner reopens a card');
    const card = this.getCard(id);
    if (card.closed?.kind !== 'returned') throw new InboxError(409, 'only a card that triage returned reopens this way');
    const pushback = card.pushback?.at(-1)?.kind === 'returned' ? card.pushback.slice(0, -1) : card.pushback;
    const next: Card = { ...card, closed: undefined, triage: undefined, ...(pushback?.length ? { pushback } : { pushback: undefined }) };
    this.store.put('cards', id, next);
    this.emit({ type: 'change', card: id });
    return next;
  }

  /** A successor agent takes over a card, and with it any answer not yet delivered. */
  claim(caller: Caller, id: string, agent: string): Card {
    const card = this.getCard(id);
    if (caller.role !== 'owner' && card.token !== caller.token) throw new InboxError(403, 'another client owns this card');
    const token = caller.role === 'owner' ? card.token : caller.token;
    // A guidance card stays the inbox's system card: the successor takes over as the agent that proposed the text.
    const next = card.kind === 'system' && card.broadcast
      ? { ...card, token, broadcast: { ...card.broadcast, from: String(agent) } }
      : { ...card, agent: String(agent), token };
    this.store.put('cards', id, next);
    this.emit({ type: 'change', card: id });
    this.flush(String(agent));
    return next;
  }

  // ---- answers ----

  async answer(id: string, input: { values?: Record<string, unknown>; comment?: string; delivery?: Delivery; version?: number; images?: (NewAttachment & { field?: string })[] }): Promise<Answer> {
    const posted = this.getCard(id);
    const delivery = input.delivery ?? 'default';
    if (!DELIVERIES.has(delivery)) throw new InboxError(400, 'unknown delivery');
    const values = input.values && typeof input.values === 'object' ? { ...input.values } : {};
    if (input.images !== undefined && !Array.isArray(input.images)) throw new InboxError(400, 'images must be a list');
    // A secret field takes only a sealed value, so plain text never reaches storage. An empty one declines.
    for (const field of sealedFields(posted)) {
      // An own property only: a field named like an inherited one, such as constructor, is empty when the answer leaves it out.
      const v = Object.hasOwn(values, field) ? values[field] : undefined;
      if (v === undefined || v === null || v === '') delete values[field];
      else if (!isSealed(v)) throw new InboxError(400, `${field} takes only a sealed value: seal it with the public key on the card`);
      if (input.images?.some((f) => f?.field === field)) throw new InboxError(400, `${field} takes no images`);
    }
    // A pairing request takes a code and its card goes a day later, and the sweep deletes the answer without its
    // files, so an image here would be stored bytes nothing can name again. The stored pairing decides, not the id:
    // an agent may post a card of its own called `pair-something`, and that one is neither swept nor a request.
    const request = posted.id.startsWith('pair-') && this.store.get<Pairing>('pairings', posted.id.slice('pair-'.length));
    if (request && input.images?.length) throw new InboxError(400, 'a pairing request takes a code, not images');
    const { images, refund } = await this.storeAnswerImages(posted, input.images);
    let card: Card;
    try {
      // Storing images awaited, so another session may have claimed the card while the files were written. Read it
      // again, and deliver to whoever holds it now: the claim's own flush ran before this answer existed.
      card = this.getCard(id);
    } catch (e) {
      // The card went while the files were written, as `reset` does, so nothing will ever name these files: give the
      // bytes back rather than leave them charged against the inbox's lifetime upload limit.
      await refund();
      throw e;
    }
    const before = this.store.get<Answer>('answers', id);
    // An answer after the agent closed the card is late. A dismissal is the person's own close, which the agent never
    // heard of, so an answer after one is not. A system card applies its answer itself, so it has no late answer.
    const late: LateAnswer | undefined = card.kind !== 'system' && card.closed && card.closed.kind !== 'dismissed'
      ? { kind: card.closed.kind, outcome: card.closed.outcome, at: card.closed.at } : undefined;
    // Approvals on a closed card are never sent, so a late answer does not keep any as approved.
    if (late) for (const k of Object.keys(values)) if (/^approval_\d+$/.test(k)) delete values[k];
    const answer: Answer = {
      card: id,
      version: Number(input.version ?? card.version),
      values,
      comment: String(input.comment ?? '').trim(),
      ...(images.length ? { images } : {}),
      ...(late ? { late } : {}),
      delivery,
      savedAt: this.now(),
      deliveredAt: null,
      readAt: null,
      forcedAt: null,
      previous: before ? [...before.previous, { ...before, previous: undefined } as Omit<Answer, 'previous'>] : [],
    };
    // A widget response tells the agent what to do with a live answer, such as merge now, so a late answer fills none.
    const responses = late ? [] : (card.responses ?? []).map((r) => respond(r.template, values, r.values)).filter(Boolean);
    if (responses.length) answer.responses = responses;
    // An approval sent for this version of the card stays sent, so a second answer never types it again.
    const kept = !late && before && before.version === answer.version ? (before.approvalResults ?? []).map((r) => (r && !('error' in r) ? r : null)) : [];
    if (kept.some(Boolean)) answer.approvalResults = kept;
    for (const p of answer.previous) delete (p as Partial<Answer>).previous;
    this.store.put('answers', id, answer);
    this.store.index(id, `${searchText(card)}\n${answer.comment}`);
    this.usage.record('answers');
    this.emit({ type: 'change', card: id });
    if (card.kind === 'system' && card.id.startsWith('pair-')) await this.resolvePairing(card, answer);
    else if (card.kind === 'system' && card.requireCard) this.resolveRequireCard(card, answer);
    else if (card.kind === 'system' && card.broadcast) this.resolveBroadcast(card, answer);
    else if (card.kind === 'system' && card.id.startsWith('priorities-')) this.resolvePriorityProposal(card, answer);
    else if (card.kind === 'system' && card.subscription) this.resolveSubscription(card, answer);
    else this.flush(card.agent);
    if (card.kind !== 'system') {
      const saved = this.store.get<Answer>('answers', id) ?? answer;
      this.observeAnswer(card, saved);
      this.queueAnswer(card, saved);
    }
    return this.store.get<Answer>('answers', id) ?? answer;
  }

  /** Type each approval the owner turned on in the card's answer into its pane, once per card version, and record what
   * happened on the answer. Only an owner's answer sends: an agent's call returns the answer unchanged. */
  async sendApprovals(caller: Caller, id: string): Promise<Answer | undefined> {
    const answer = this.store.get<Answer>('answers', id);
    const sender = this.approvalSender;
    const card = this.store.get<Card>('cards', id);
    // A late answer types nothing: the agent closed the card, so the sentence it asked to type is no longer its request.
    if (!sender || caller.role !== 'owner' || !answer || answer.late || !card?.approvals?.length) return answer;
    const approvals = card.approvals;
    const results: ApprovalResult[] = approvals.map((_, i) => answer.approvalResults?.[i] ?? null);
    const claimed: number[] = [];
    approvals.forEach((_, i) => {
      const r = results[i];
      if (answer.values[`approval_${i}`] !== true || (r && !('error' in r))) return;
      // The person read other sentences on the version they answered, so the inbox sends none of the new ones.
      if (answer.version !== card.version) { results[i] = { error: 'the card changed after you answered it: answer it again to send this' }; return; }
      results[i] = { sendingAt: this.now() };
      claimed.push(i);
    });
    if (!results.some(Boolean)) return answer;
    // The claim is written before the first await, so an answer saved meanwhile carries it and never sends again.
    this.store.put('answers', id, { ...answer, approvalResults: results });
    this.emit({ type: 'change', card: id });
    for (const i of claimed) {
      const a = approvals[i]!;
      let result: ApprovalResult;
      try {
        await sender.send(a.pane, a.text);
        result = { sentAt: this.now() };
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      this.recordApproval(id, answer.version, i, result);
    }
    return this.store.get<Answer>('answers', id);
  }

  /** Replace the claim on one approval with what the send did, on whichever answer to that card version is current. */
  private recordApproval(id: string, version: number, i: number, result: ApprovalResult): void {
    const answer = this.store.get<Answer>('answers', id);
    const claim = answer?.approvalResults?.[i];
    if (!answer || answer.version !== version || !claim || !('sendingAt' in claim)) return;
    const results = [...(answer.approvalResults ?? [])];
    results[i] = result;
    this.store.put('answers', id, { ...answer, approvalResults: results });
    this.emit({ type: 'change', card: id });
  }

  /** What herdr says about each approval's pane, one entry per approval, empty when herdr does not know the pane. */
  private async describePanes(approvals: Approval[]): Promise<(Approval['place'] | undefined)[]> {
    const describe = this.approvalSender?.describe?.bind(this.approvalSender);
    if (!describe) return approvals.map(() => undefined);
    return Promise.all(approvals.map((a) => describe(a.pane).catch(() => undefined)));
  }

  /** A card's approvals, checked. A place comes only from `places`, which herdr answered, so an agent cannot set one. */
  private cleanApprovals(input: unknown, kind: string, places?: (Approval['place'] | undefined)[]): Approval[] | undefined {
    if (input === undefined || input === null) return undefined;
    if (!this.approvalSender) throw new InboxError(400, 'this inbox does not send approvals: only an inbox on the computer that runs herdr types into a pane');
    if (kind !== 'ask') throw new InboxError(400, 'only an ask card takes approvals');
    if (!Array.isArray(input)) throw new InboxError(400, 'approvals must be a list of {pane, text, label}');
    if (input.length > MAX_APPROVALS) throw new InboxError(400, `a card takes at most ${MAX_APPROVALS} approvals`);
    if (!input.length) return undefined;
    return input.map((a: unknown, i): Approval => {
      const at = `approval ${i + 1}`;
      if (!a || typeof a !== 'object') throw new InboxError(400, `${at}: must be an object with pane and text`);
      const { pane, text, label } = a as Record<string, unknown>;
      if (typeof pane !== 'string' || !PANE_ID.test(pane)) throw new InboxError(400, `${at}: pane must be a herdr pane id, such as w6P:p2`);
      if (typeof text !== 'string' || !text.trim()) throw new InboxError(400, `${at}: text must be the message to send`);
      if (text.length > MAX_APPROVAL_CHARS) throw new InboxError(400, `${at}: text must be at most 1,000 characters`);
      // herdr reads an argument that starts with a dash as an option, and takes no -- before the text.
      if (text.startsWith('-')) throw new InboxError(400, `${at}: text must not start with a dash`);
      if (label !== undefined && (typeof label !== 'string' || label.length > MAX_APPROVAL_LABEL_CHARS)) throw new InboxError(400, `${at}: label must be at most ${MAX_APPROVAL_LABEL_CHARS} characters`);
      const kept = cleanPlace(places?.[i]);
      return { pane, text, ...(label ? { label } : {}), ...(kept ? { place: kept } : {}) };
    });
  }

  /** Delete files a caller wrote and give their bytes back to the lifetime upload limit, for a write that cannot stand. */
  private async refundUploads(stored: { id?: string }[], bytes: number): Promise<void> {
    await Promise.all(stored.map((f) => this.blobs.delete(f.id ?? '')));
    this.store.put('meta', 'uploaded-bytes', Math.max(0, this.uploads().used - bytes));
  }

  /** Store the images pasted into an answer, and return their references. Each must be a base64 image of a type the page
   * shows, within the attachment limit. The files count against the upload limit like a card's files. */
  private async storeAnswerImages(card: Card, input: (NewAttachment & { field?: string })[] | undefined): Promise<{ images: Attachment[]; refund: () => Promise<void> }> {
    const none = { images: [] as Attachment[], refund: async (): Promise<void> => {} };
    if (input === undefined) return none;
    if (!Array.isArray(input)) throw new InboxError(400, 'images must be a list');
    if (input.length > MAX_ANSWER_IMAGES) throw new InboxError(400, `an answer takes at most ${MAX_ANSWER_IMAGES} images`);
    const decoded = input.map((f, i) => {
      if (!f || typeof f !== 'object' || !/^data:/.test(String(f.src ?? ''))) throw new InboxError(400, `image ${i + 1}: src must be a base64 data: URL`);
      const d = decodeDataUrl(i, f);
      return d;
    });
    const bytes = decoded.reduce((n, d) => n + Math.max(d.bytes.length, MIN_FILE_CHARGE), 0);
    const { used, limit } = this.uploads();
    if (bytes > MAX_ANSWER_IMAGE_BYTES) throw new InboxError(413, `these images are ${bytes} bytes, and an answer takes at most ${MAX_ANSWER_IMAGE_BYTES}`);
    if (limit !== undefined && used + bytes > limit) throw new InboxError(413, `these images are ${bytes} bytes, and this inbox has stored ${used} of its lifetime limit of ${limit} bytes`);
    if (bytes) this.store.put('meta', 'uploaded-bytes', used + bytes);
    const stored: Attachment[] = [];
    // A caller that cannot keep the references deletes the files and gives the bytes back, as a card post does.
    const refund = (): Promise<void> => this.refundUploads(stored, bytes);
    const settled = await Promise.allSettled(input.map(async (f, i): Promise<void> => {
      const d = decoded[i]!;
      const key = `${card.id}.a${i}.${randomId(6)}`;
      const ref: Attachment = { id: key, name: cleanName(f.name) || `pasted-${i + 1}.${d.type.slice(6).replace('jpeg', 'jpg')}`, type: d.type, size: d.bytes.length, ...(f.field ? { field: String(f.field).slice(0, 80) } : {}) };
      stored.push(ref);
      await this.blobs.put(key, d.bytes, d.type);
    }));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) {
      await refund();
      throw (failed as PromiseRejectedResult).reason;
    }
    return { images: stored, refund };
  }

  /** The model has the answer in its context. */
  ack(caller: Caller, id: string): Answer {
    this.owned(caller, id);
    const answer = this.store.get<Answer>('answers', id);
    if (!answer) throw new InboxError(404, 'no answer for this card');
    if (!answer.readAt) {
      const next = { ...answer, readAt: this.now(), deliveredAt: answer.deliveredAt ?? this.now() };
      this.store.put('answers', id, next);
      this.emit({ type: 'change', card: id });
      return next;
    }
    return answer;
  }

  /** Send an unread answer again, marked to interrupt the agent. */
  force(id: string): Answer {
    const answer = this.store.get<Answer>('answers', id);
    if (!answer) throw new InboxError(404, 'no answer for this card');
    if (answer.readAt) return answer;
    const next: Answer = { ...answer, delivery: 'force', deliveredAt: null, forcedAt: this.now() };
    this.store.put('answers', id, next);
    this.emit({ type: 'change', card: id });
    const card = this.getCard(id);
    this.flush(recipient(card, next) ?? card.agent);
    // A webhook call that waits for its retry goes now. A call still running keeps its lease, so it never goes twice at once.
    const now = this.now();
    for (const d of this.store.list<OutboxItem>('outbox')) {
      if (d.card === id && !(d.calling && d.nextAt > now)) this.store.put<OutboxItem>('outbox', d.key, { ...d, nextAt: Math.min(d.nextAt, now) });
    }
    this.track(this.deliverAnswers());
    return this.store.get<Answer>('answers', id) ?? next;
  }

  /** Answers that wait for an agent that is offline. Agents query and claim them. */
  deadLetters(): { card: Card; answer: Answer }[] {
    return this.store.list<Answer>('answers')
      .filter((a) => !a.deliveredAt)
      .map((a) => ({ card: this.getCard(a.card), answer: a }))
      .filter(({ card, answer }) => { const to = recipient(card, answer); return to !== null && !this.isOnline(to); });
  }

  /** The answers this caller has not consumed: stored, and never acknowledged. `agent` narrows it to one agent, which
   * is what a watcher asks about. The ids come with the count, so a caller can acknowledge them without a second read. */
  unread(caller: Caller, agent?: string): { unread: number; cards: string[] } {
    const mine = this.store.list<Answer>('answers')
      .filter((a) => !a.readAt)
      .filter((a) => {
        const card = this.store.get<Card>('cards', a.card);
        if (!card) return false;
        // A proposal card closes as the person answers it, and its answer waits for the agent that proposed the text.
        const proposal = card.kind === 'system' && (card.broadcast ?? card.requireCard);
        const from = card.broadcast?.from ?? card.requireCard?.from;
        if (proposal ? recipient(card, a) === null : cardState(card, a) === 'closed') return false;
        if (caller.role !== 'owner' && card.token !== caller.token) return false;
        return agent === undefined || (proposal ? from : card.agent) === agent;
      })
      .map((a) => a.card)
      .sort();
    return { unread: mine.length, cards: mine.slice(0, UNREAD_ID_LIMIT) };
  }

  /** Cards that match the words and the filters, best match first, and newest change first when no words are given.
   * An empty query, or `*`, lists every card the filters match. `nextCursor` continues a longer list. */
  search(query: string, filters: SearchFilters = {}): SearchPage {
    const words = String(query ?? '').trim();
    // No words list every card, so an agent can ask for the open cards without inventing a word for them.
    const text = /^\*+$/.test(words) ? '' : words;
    const cards = text
      ? this.store.search(text, Number.MAX_SAFE_INTEGER).map((h) => this.store.get<Card>('cards', h.card)).filter((c): c is Card => !!c)
      : this.store.list<Card>('cards').sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
    return this.pageOf(cards, filters, 20);
  }

  /** The cards a client may read, with their states: all of them for the owner. Takes the filters of a search without
   * the words, and returns every matching card unless a `limit` asks for pages. */
  listCards(caller: Caller, filters: SearchFilters = {}): { results: { card: Card; state: CardState }[]; nextCursor?: string } {
    const page = this.pageOf(this.store.list<Card>('cards').filter((c) => caller.role === 'owner' || c.token === caller.token), filters);
    return { results: page.results.map(({ card, state }) => ({ card, state })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  /** Filter the cards, page them, and give each result its answer and its state. */
  private pageOf(cards: Card[], filters: SearchFilters, defaultLimit?: number): SearchPage {
    if (filters.state !== undefined && !CARD_STATES.has(filters.state)) throw new InboxError(400, `state must be one of ${[...CARD_STATES].join(', ')}`);
    checkFeedbackFilter(filters.triageFeedback);
    const offset = readCursor(filters.cursor);
    const asked = filters.limit ?? defaultLimit;
    if (asked !== undefined && (!Number.isInteger(asked) || asked < 1)) throw new InboxError(400, 'limit must be a whole number of results');
    const matched = cards
      .map((card) => ({ card, answer: this.store.get<Answer>('answers', card.id) }))
      .filter(({ card, answer }) => this.matchesFilters(card, answer, filters));
    const limit = asked === undefined ? matched.length : Math.min(asked, MAX_SEARCH_LIMIT);
    const results = matched.slice(offset, offset + limit).map(({ card, answer }): SearchResult => (
      { card: publicCard(card), ...(answer ? { answer } : {}), state: this.shownState(card, this.store.get<Presence>('presence', card.agent), answer) }
    ));
    return offset + limit < matched.length ? { results, nextCursor: writeCursor(offset + limit) } : { results };
  }

  /** Whether a card passes every filter given. A search and the cards listing filter the same way. */
  private matchesFilters(card: Card, answer: Answer | undefined, f: SearchFilters): boolean {
    if (f.answered && !answer) return false;
    if (f.state !== undefined && this.shownState(card, this.store.get<Presence>('presence', card.agent), answer) !== f.state) return false;
    for (const tag of f.tags ?? []) {
      const at = tag.indexOf('=');
      const key = at < 0 ? tag : tag.slice(0, at);
      if (!card.tags || !Object.hasOwn(card.tags, key)) return false;
      if (at >= 0 && card.tags[key] !== tag.slice(at + 1)) return false;
    }
    // A session name is what the person sees on the card, and the agent id is what the client knows.
    if (f.agent !== undefined && card.agent !== f.agent && !(card.origin?.name ?? '').toLowerCase().includes(f.agent.toLowerCase())) return false;
    if (f.since !== undefined || f.before !== undefined) {
      const inside = (t: number): boolean => (f.since === undefined || t >= f.since) && (f.before === undefined || t <= f.before);
      if (!inside(card.createdAt) && !inside(card.updatedAt)) return false;
    }
    if (f.links !== undefined) {
      const needle = f.links.toLowerCase();
      if (!cardLinks(card).some((link) => link.toLowerCase().includes(needle))) return false;
    }
    if (f.triageFeedback !== undefined && !hasFeedback(card, f.triageFeedback)) return false;
    return true;
  }

  /** This inbox's stable identity, the same over every link to it. */
  id(): string {
    let id = this.store.get<string>('meta', 'inbox-id');
    if (!id) { id = randomId(8); this.store.put('meta', 'inbox-id', id); }
    return id;
  }

  /** The stored result of a message this client sent before, by its id. */
  recallMessage(key: string): { status: number; body: string } | undefined {
    const m = this.store.get<{ status: number; body: string; at: number }>('messages', key);
    // A reservation whose request died, such as in a crash, lets the message be applied again.
    if (m && m.status === 0 && this.now() - m.at > MESSAGE_RESERVATION_MS) return undefined;
    return m;
  }

  rememberMessage(key: string, status: number, body: string): void {
    this.store.put('messages', key, { key, status, body, at: this.now() });
  }

  forgetMessage(key: string): void {
    this.store.delete('messages', key);
  }

  // ---- default tags ----

  /** The default tags this caller set for one agent id. A token reads only the defaults it set itself. */
  defaultTags(caller: Caller, agent: string): DefaultTags {
    if (caller.role !== 'agent') throw new InboxError(403, 'only an agent reads its own default tags');
    const id = this.agentId(agent);
    return { agent: id, tags: this.storedTags(caller.token, id) };
  }

  /** Set, merge, remove or clear the default tags this caller keeps for one agent id. Every card that agent posts
   * inherits them, under its own tags. */
  setDefaultTags(caller: Caller, input: Partial<DefaultTagsWrite>): DefaultTags {
    if (caller.role !== 'agent') throw new InboxError(403, 'only an agent sets its own default tags');
    const agent = this.agentId(input.agent);
    const from = input.from === undefined ? 'card_tags' : String(input.from);
    if (!/^[A-Za-z_][\w.-]{0,39}$/.test(from)) throw new InboxError(400, 'from must be 1 to 40 letters, digits, dots, dashes or underscores');
    const key = `tags:${caller.token}`;
    const row = this.store.get<DefaultTagRow>('meta', key);
    const agents = { ...(row?.agents ?? {}) };
    const tags: Record<string, DefaultTag> = input.clear === true ? {} : { ...(agents[agent] ?? {}) };
    if (input.tags !== undefined) {
      if (!input.tags || typeof input.tags !== 'object' || Array.isArray(input.tags)) throw new InboxError(400, 'tags must be an object of tag keys and values');
      for (const [k, v] of Object.entries(input.tags)) {
        if (!k) throw new InboxError(400, 'each tag needs a key');
        if (k.length > MAX_TAG_CHARS) throw new InboxError(400, `tag key ${k.slice(0, 20)}… must be at most ${MAX_TAG_CHARS} characters`);
        const value = String(v ?? '');
        if (!value) throw new InboxError(400, `tag ${k} has an empty value: leave it out, or remove it`);
        if (value.length > MAX_TAG_CHARS) throw new InboxError(400, `tag ${k} must be at most ${MAX_TAG_CHARS} characters`);
        tags[k] = { value, from };
      }
    }
    if (input.remove !== undefined) {
      if (!Array.isArray(input.remove)) throw new InboxError(400, 'remove must be a list of tag keys');
      for (const k of input.remove.map(String)) delete tags[String(k)];
    }
    if (Object.keys(tags).length > MAX_TAGS) throw new InboxError(400, `an agent keeps at most ${MAX_TAGS} default tags`);
    if (Object.keys(tags).length) agents[agent] = tags;
    else delete agents[agent];
    if (Object.keys(agents).length) this.store.put<DefaultTagRow>('meta', key, { token: caller.token, agents, at: this.now() });
    else this.store.delete('meta', key);
    return { agent, tags };
  }

  /** Every token's default tags, or one agent's, for the owner. */
  defaultTagsList(caller: Caller, agent?: string): { token: string; agent: string; tags: Record<string, DefaultTag> }[] {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner reads every default tag');
    const out: { token: string; agent: string; tags: Record<string, DefaultTag> }[] = [];
    for (const row of this.store.list<DefaultTagRow>('meta')) {
      if (typeof row?.token !== 'string' || !row.agents) continue;
      for (const [id, tags] of Object.entries(row.agents)) {
        if ((agent === undefined || id === agent) && tags && Object.keys(tags).length) out.push({ token: row.token, agent: id, tags });
      }
    }
    return out;
  }

  /** The tag keys a post by this caller takes from its defaults, read after the card commits. The route names them in
   * the reply, so an agent knows what it inherited without reading the card back. */
  inheritedTags(caller: Caller, input: NewCard): string[] {
    if (caller.token === '' || (input.kind ?? 'ask') === 'system') return [];
    return mergeDefaultTags(this.tagValues(caller.token, String(input.agent ?? '').trim()), ownTags(input.tags)).inherited;
  }

  /** The defaults this token keeps for one agent id, by value. */
  private tagValues(token: string, agent: string): Record<string, string> {
    return Object.fromEntries(Object.entries(this.storedTags(token, agent)).map(([k, t]) => [k, t.value]));
  }

  private storedTags(token: string, agent: string): Record<string, DefaultTag> {
    return this.store.get<DefaultTagRow>('meta', `tags:${token}`)?.agents?.[agent] ?? {};
  }

  private agentId(agent: unknown): string {
    const id = String(agent ?? '').trim();
    if (!id) throw new InboxError(400, 'agent is required');
    if (id.length > MAX_AGENT_CHARS) throw new InboxError(400, `agent must be at most ${MAX_AGENT_CHARS} characters`);
    return id;
  }

  // ---- cards the person sends to an agent ----

  /** The person sends a card to an agent. It goes on that agent's stream as a `card` event as soon as a connection for
   * the agent is open, and waits for the session that connects next when none is: an agent's state never stops it being
   * addressed (DP18, DP19). The agent replies with a card of its own, so the card carries the message and nothing else. */
  sendCard(caller: Caller, input: { agent?: unknown; text?: unknown } | null | undefined): SentCard {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner sends a card to an agent');
    const agent = this.agentId(input?.agent);
    const text = String(input?.text ?? '').trim();
    if (!text) throw new InboxError(400, 'text is required');
    // The first line of the message titles the card, and the lines under it are its text, so a one-line message reads once.
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.trim());
    const now = this.now();
    // The card never sits in the person's queue, so its priority is only what an agent reads. It follows the levels as a post does.
    const levels = this.priorities();
    const card: Card = {
      id: randomId(8),
      agent,
      kind: 'ask',
      title: (lines[at] ?? '').trim().slice(0, 300),
      text: lines.slice(at + 1).join('\n').trim() || undefined,
      priority: levels.some((l) => l.id === 'soon') ? 'soon' : levels[0]?.id ?? 'soon',
      replies: [],
      deliver: 'stream',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const size = new TextEncoder().encode(JSON.stringify(card)).length;
    if (size > MAX_CARD_BYTES) throw new InboxError(413, `the card is ${size} bytes, over the limit of ${MAX_CARD_BYTES}`);
    this.store.put<SentCard>('sent', card.id, { id: card.id, agent, card, sentAt: now });
    this.deliverSent(agent);
    return this.store.get<SentCard>('sent', card.id) ?? { id: card.id, agent, card, sentAt: now };
  }

  /** Hand each card waiting for this agent to its open streams, and record when it went. A connection reports an agent id,
   * as a guidance event looks up its agents, so an agent takes what is addressed to it whatever token it connected with. */
  private deliverSent(agent: string): void {
    const waiting = this.store.list<SentCard>('sent').filter((s) => s.agent === agent && !s.deliveredAt);
    if (!waiting.length) return;
    // The agent id is what follows the first newline of the key, so an id that contains one cannot match another's.
    const sends = [...this.agents].filter(([k]) => k.slice(k.indexOf('\n') + 1) === agent).flatMap(([, subs]) => [...subs]);
    if (!sends.length) return;
    const now = this.now();
    for (const sent of waiting) {
      this.store.put<SentCard>('sent', sent.id, { ...sent, deliveredAt: now });
      const event: AgentEvent = { type: 'card', id: sent.id, card: publicCard(sent.card), sentAt: sent.sentAt };
      for (const send of sends) send(event);
    }
  }

  // ---- connections ----

  private key(token: string, agent: string): string {
    return `${token}\n${agent}`;
  }

  isOnline(agent: string): boolean {
    return this.store.get<Presence>('presence', agent)?.online ?? false;
  }

  /** An agent connects. `instance` names the agent process, and stays the same across its reconnects. `resumed` marks a
   * connection the platform rebuilt for a socket that stayed open, such as a Durable Object waking from hibernation:
   * the agent already got its `hello` on that socket, so it gets none again. `channelOff` says the session discards
   * channel notifications, and a connection that leaves it out keeps what the last one said. `origin` says where the
   * session runs, so a page can label the session before it posts any card, and a connection that leaves it out keeps
   * the origin the row already carries. */
  connect(caller: Caller, agent: string, send: AgentSend, instance?: string, opts: { resumed?: boolean; channelOff?: boolean; origin?: unknown } = {}): () => void {
    if (String(agent).length > MAX_AGENT_CHARS) throw new InboxError(400, `agent must be at most ${MAX_AGENT_CHARS} characters`);
    const k = this.key(caller.token, agent);
    let set = this.agents.get(k);
    if (!set) this.agents.set(k, (set = new Set()));
    set.add(send);
    if (instance) this.instances.set(send, instance);
    this.usage.saw('agents', agent);
    if (instance) this.usage.saw('instances', instance);
    if (caller.token) this.usage.saw('tokens', caller.token);
    this.setPresence(agent, true, opts.channelOff, opts.origin);
    if (!opts.resumed) send({ type: 'hello', agent, version: 1, guidance: this.guidance().version });
    this.flush(agent);
    // A card the person sent while this agent was away goes out as soon as it connects, as a waiting answer does.
    this.deliverSent(agent);
    if (instance) this.resend(caller.token, agent, send, instance);
    return () => {
      const s = this.agents.get(k);
      if (!s?.delete(send)) return;
      if (s.size === 0) this.agents.delete(k);
      // The agent id follows the first newline of the key, so an id carrying one cannot stand for another agent.
      const stillOpen = [...this.agents.keys()].some((x) => x.slice(x.indexOf('\n') + 1) === agent);
      if (!stillOpen) this.putPresence(agent, { online: true, lastSeen: this.now(), leftAt: this.now() });
    };
  }

  /** `channelOff` is undefined for a connection that says nothing about the channel, which keeps what is stored. An
   * `origin` the connection reports replaces the stored one, and a connection that reports none keeps it, as it does
   * for the channel. */
  private setPresence(agent: string, online: boolean, channelOff?: boolean, reported?: unknown): void {
    const before = this.store.get<Presence>('presence', agent);
    const off = channelOff ?? before?.channelOff;
    const origin = connectionOrigin(reported) ?? before?.origin;
    const next: Presence = { ...before, agent, online, lastSeen: this.now() };
    delete next.channelOff;
    if (off) next.channelOff = true;
    delete next.origin;
    if (origin) next.origin = origin;
    // A live connection has no closing time, and one left from an earlier close would arm the alarm for a past moment.
    if (online) delete next.leftAt;
    this.store.put<Presence>('presence', agent, next);
    this.emit({ type: 'presence', agent, online });
  }

  /** A live connection reports where its session runs now, as one does after the person renames the session. Only a
   * connection of this token for this agent may, so one client cannot relabel another's session. The row and the pages
   * change only when the kept fields differ, so a client that repeats itself costs a read. Answers whether it changed. */
  reportOrigin(caller: Caller, agent: string, reported: unknown): boolean {
    if (!this.agents.get(this.key(caller.token, agent))?.size) throw new InboxError(409, `no connection of yours for ${agent}`);
    const origin = connectionOrigin(reported);
    if (!origin) return false;
    const before = this.store.get<Presence>('presence', agent);
    if (JSON.stringify(before?.origin ?? {}) === JSON.stringify(origin)) return false;
    this.store.put<Presence>('presence', agent, { ...before, agent, online: true, lastSeen: this.now(), origin });
    this.emit({ type: 'presence', agent, online: true });
    return true;
  }

  /** Write a presence change over what is stored, so the fields a change does not name stay. */
  private putPresence(agent: string, change: Partial<Presence>): void {
    const before = this.store.get<Presence>('presence', agent);
    this.store.put<Presence>('presence', agent, { ...before, agent, online: false, lastSeen: this.now(), ...change });
  }

  /** Send a new agent process each answer an earlier process received but never read, such as one a session got before it restarted. */
  private resend(token: string, agent: string, send: AgentSend, instance: string): void {
    for (const answer of this.store.list<Answer>('answers')) {
      if (!answer.deliveredAt || answer.readAt || answer.deliveredTo?.includes(instance)) continue;
      const card = this.store.get<Card>('cards', answer.card);
      if (!card || recipient(card, answer) !== agent || (card.token ?? '') !== token) continue;
      const next: Answer = { ...answer, deliveredTo: [...(answer.deliveredTo ?? []), instance] };
      this.store.put('answers', answer.card, next);
      send({ type: 'answer', id: randomId(6), card: publicCard(card), answer: next });
    }
  }

  /** Deliver each answer the agent has not received yet. */
  private flush(agent: string): void {
    for (const answer of this.store.list<Answer>('answers')) {
      if (answer.deliveredAt) continue;
      const card = this.store.get<Card>('cards', answer.card);
      if (!card || recipient(card, answer) !== agent) continue;
      const subs = this.agents.get(this.key(card.token ?? '', agent));
      if (!subs || subs.size === 0) continue;
      const to = [...subs].map((f) => this.instances.get(f)).filter((x): x is string => !!x);
      const next: Answer = { ...answer, deliveredAt: this.now(), ...(to.length ? { deliveredTo: to } : {}) };
      this.store.put('answers', answer.card, next);
      const ev: AgentEvent = { type: 'answer', id: randomId(6), card: publicCard(card), answer: next };
      for (const send of subs) send(ev);
      this.emit({ type: 'change', card: card.id });
    }
  }

  /** A page opens its event stream. `viewer` is the page's own id, for its presence reports. */
  subscribePage(send: PageSend, viewer?: string, guard?: { unlock: string | undefined; close: () => void }): () => void {
    this.pages.add(send);
    if (guard) this.guarded.set(send, guard);
    if (viewer) this.usage.saw('pages', viewer);
    if (viewer) { this.viewers.set(viewer, this.viewers.get(viewer) ?? { visible: true, activeAt: this.now(), focus: null }); this.personChanged(); }
    // A socket that wakes after the PIN changed closes at once.
    if (guard && this.pin.isSet() && !this.pin.live(guard.unlock)) queueMicrotask(() => this.closeLockedPages());
    return () => {
      this.pages.delete(send);
      this.guarded.delete(send);
      if (viewer && this.viewers.delete(viewer)) this.personChanged();
    };
  }

  /** A page reports whether it is visible, that the person did something, and the card on its screen. */
  reportViewer(viewer: string, report: { visible?: boolean; active?: boolean; focus?: string | null }): PersonPresence {
    if (!/^[\w-]{4,64}$/.test(String(viewer))) throw new InboxError(400, 'viewer must be 4 to 64 letters, digits, dashes or underscores');
    const before = this.viewers.get(viewer) ?? { visible: true, activeAt: null, focus: null };
    const next = {
      visible: typeof report.visible === 'boolean' ? report.visible : before.visible,
      activeAt: report.active ? this.now() : before.activeAt,
      focus: report.focus === undefined ? before.focus : report.focus ? String(report.focus) : null,
    };
    this.viewers.set(viewer, next);
    // Extensions hear about a change in what the person sees, not about every keypress.
    if (next.visible !== before.visible || next.focus !== before.focus) return this.personChanged();
    const person = this.person();
    this.store.put('meta', 'person', person);
    return person;
  }

  person(): PersonPresence {
    const views = [...this.viewers.values()];
    const shown = views.filter((v) => v.visible).sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
    const activeAt = views.reduce<number | null>((m, v) => (v.activeAt !== null && (m === null || v.activeAt > m) ? v.activeAt : m), null);
    return { pages: views.length, visible: shown.length > 0, activeAt, focus: shown[0]?.focus ?? null, at: this.now() };
  }

  private personChanged(): PersonPresence {
    const person = this.person();
    this.store.put('meta', 'person', person);
    const event: HookEvent = { type: 'hook', version: HOOK_VERSION, id: randomId(8), hook: 'person.changed', person };
    for (const e of this.extensions.values()) if (e.reg.hooks.includes('person.changed')) e.send(event);
    return person;
  }

  /** The page code changed: open pages reload and keep their drafts. */
  announceCode(): void {
    this.emit({ type: 'code' });
  }

  private emit(ev: PageEvent): void {
    for (const send of this.pages) send(ev);
  }

  /** Called by the platform alarm: ends presence after its grace, forgets old message ids,
   * resolves late hook calls, and expires pairing requests and cards. */
  sweep(): void {
    const now = this.now();
    for (const p of this.store.list<Presence>('presence')) {
      const open = [...this.agents.keys()].some((x) => x.endsWith(`\n${p.agent}`));
      if (p.online && p.leftAt !== undefined && now - p.leftAt >= PRESENCE_GRACE_MS && !open) {
        // The agent was last seen when its connection closed, not when the alarm noticed.
        this.putPresence(p.agent, { online: false, lastSeen: p.leftAt });
        this.emit({ type: 'presence', agent: p.agent, online: false });
      } else if (!p.online && now - (p.leftAt ?? p.lastSeen) >= PRESENCE_KEEP_MS) {
        // The row of an agent gone this long only makes GET /v1/state bigger. A reconnect writes a fresh one.
        this.store.delete('presence', p.agent);
      }
    }
    // Download counts from earlier days go.
    const today = `reads:${new Date(now).toISOString().slice(0, 10)}:`;
    for (const m of this.store.list<unknown>('meta')) {
      const key = (m as { key?: unknown })?.key;
      if (typeof key === 'string' && key.startsWith('reads:') && !key.startsWith(today)) this.store.delete('meta', key);
      const expiresAt = (m as { expiresAt?: unknown })?.expiresAt;
      if (typeof key === 'string' && key.startsWith('signin:') && typeof expiresAt === 'number' && expiresAt <= now) this.store.delete('meta', key);
      const guesses = key === SIGN_IN_GUESSES ? (m as { at?: unknown }).at : undefined;
      if (Array.isArray(guesses) && guesses.every((at) => typeof at !== 'number' || now - at >= SIGN_IN_GUESS_WINDOW_MS)) this.store.delete('meta', SIGN_IN_GUESSES);
    }
    this.pin.sweep();
    for (const m of this.store.list<{ key: string; at: number }>('messages')) {
      if (now - m.at > MESSAGE_MEMORY_MS) this.store.delete('messages', m.key);
    }
    // A card the person sent to an agent that never came back only makes the storage bigger after a while.
    for (const sent of this.store.list<SentCard>('sent')) {
      if (now - sent.sentAt >= SENT_KEEP_MS) this.store.delete('sent', sent.id);
    }
    for (const card of this.store.list<Card>('cards')) {
      const t = card.triage;
      if (t?.state === 'pending' && t.deadline && t.deadline <= now) {
        const late = (t.waiting ?? []).join(', ') || 'triage';
        const { advice = [], ...rest } = t;
        const triage = t.policy === 'fail-closed'
          ? { ...rest, state: 'held' as const, reason: `${late} did not answer in time, and its policy holds the card.`, waiting: [], at: now }
          : { ...rest, state: 'passed' as const, reason: `${late} did not answer in time, so the card went through.`, waiting: [], at: now };
        const shown = this.passWithAdvice({ ...card, triage }, triage.state === 'passed' ? advice : []);
        this.emit({ type: 'change', card: card.id });
        if (shown.first) this.pushNew(shown.card);
      }
      if (card.expiresAt && card.expiresAt <= now && !card.closed && !this.store.get('answers', card.id)) {
        this.closeAs(card, 'expired', 'The agent stopped waiting for an answer.');
      }
    }
    for (const p of this.store.list<Pairing>('pairings')) {
      if (now - p.createdAt >= PAIRING_KEEP_MS) {
        // A day later, the request and its card go, so pairing requests cannot pile up.
        this.store.delete('pairings', p.id);
        this.store.delete('cards', `pair-${p.id}`);
        this.store.delete('answers', `pair-${p.id}`);
        this.store.index(`pair-${p.id}`, '');
        this.emit({ type: 'change', card: `pair-${p.id}` });
        continue;
      }
      if (now - p.createdAt < PAIRING_TTL_MS) continue;
      // A token nobody collected in time is dropped, so its secret never stays in storage.
      if (p.secret) {
        const { secret: _s, ...rest } = p;
        this.store.put<Pairing>('pairings', p.id, rest);
        continue;
      }
      if (p.status !== 'pending') continue;
      this.store.put<Pairing>('pairings', p.id, { ...p, status: 'denied' });
      const card = this.store.get<Card>('cards', `pair-${p.id}`);
      if (card && !card.closed) this.closeAs(card, 'resolved', 'The pairing request expired.');
    }
  }

  /** Everything a page needs to draw the inbox. */
  /** Clear the cards you dealt with: answered, retracted or closed. Search still finds them. */
  archive(caller: Caller): { archived: number } {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner clears the inbox');
    const now = this.now();
    let archived = 0;
    for (const card of this.store.list<Card>('cards')) {
      if (card.archivedAt) continue;
      const answer = this.store.get<Answer>('answers', card.id);
      const s = cardState(card, answer);
      if (!['closed', 'answered', 'delivered', 'read'].includes(s)) continue;
      this.store.put('cards', card.id, { ...card, archivedAt: now });
      archived++;
    }
    if (archived) this.emit({ type: 'change', card: '' });
    return { archived };
  }

  /** Remove every card, answer and attached file. Tokens, templates, widgets, settings and guidance stay. */
  async reset(caller: Caller): Promise<{ removed: number }> {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner resets the inbox');
    const cards = this.store.list<Card>('cards');
    for (const sent of this.store.list<SentCard>('sent')) this.store.delete('sent', sent.id);
    for (const card of cards) await Promise.all(this.drop(card).map((f) => this.blobs.delete(f)));
    this.emit({ type: 'change', card: '' });
    return { removed: cards.length };
  }

  /** Called by the platform alarm after sweep(). Deletes the cards of `purgeQueue` whose 30 days are up, and the oldest
   * others while the storage is past its headroom, at most PURGE_BATCH a pass. It removes what `reset` removes for each. */
  async purge(): Promise<{ removed: number }> {
    const now = this.now();
    const files: string[] = [];
    let removed = 0;
    for (const { id, since } of this.purgeQueue()) {
      if (removed >= PURGE_BATCH || (now - since < PURGE_AFTER_MS && !this.needsRoom())) break;
      const card = this.store.get<Card>('cards', id);
      if (!card) {
        // A row whose card is gone would stay due forever, so it goes too.
        this.store.delete('cleared', id);
        this.store.delete('summaries', id);
        continue;
      }
      files.push(...this.drop(card));
      removed++;
    }
    // Every record goes before the first await, so no request sees half a batch.
    if (removed) this.emit({ type: 'change', card: '' });
    // The records are gone already, so a failed delete must not stop the alarm that called this. R2 deletes the file
    // 30 days after its upload anyway, and a laptop retries the delete on its next pass.
    const retry = this.store.get<string[]>('meta', PENDING_FILE_DELETES) ?? [];
    const settled = await Promise.allSettled([...retry, ...files].map((f) => this.blobs.delete(f)));
    const failed = [...retry, ...files].filter((_, i) => settled[i]?.status === 'rejected').slice(0, PURGE_BATCH * 10);
    if (failed.length) this.store.put('meta', PENDING_FILE_DELETES, failed);
    else if (retry.length) this.store.delete('meta', PENDING_FILE_DELETES);
    return { removed };
  }

  /** The cards the purge may delete, oldest first, each with the time its 30 days start: a cleared card from when the
   * person cleared it, and a card nobody answered from its last revision. An answered card on show stays.
   * It reads the summaries and the oldest PURGE_BATCH cleared rows: a pass deletes no more, and the later rows are newer.
   * So its time follows the cards on show, never the cleared ones or the size of their text. */
  private purgeQueue(): { id: string; since: number }[] {
    const queue = this.store.first<ClearedCard>('cleared', PURGE_BATCH).map((c) => ({ id: c.id, since: c.archivedAt }));
    for (const s of this.store.list<CardSummary>('summaries')) {
      if (!s.answer) queue.push({ id: s.id, since: s.updatedAt });
    }
    return queue.sort((a, b) => a.since - b.since);
  }

  /** Whether the storage holds more than its limit less the headroom the purge keeps free. */
  private needsRoom(): boolean {
    return this.storageLimit !== undefined && (this.store.bytes?.() ?? 0) > this.storageLimit * (1 - STORAGE_HEADROOM);
  }

  /** Delete a card's records and search entry, and return the ids of its files and answer images, for the caller to
   * delete. The records go first: an answer that lands while the files are deleted then finds no card, and `answer`
   * refunds the images it had already stored instead of leaving them where this list cannot name them. */
  private drop(card: Card): string[] {
    const answer = this.store.get<Answer>('answers', card.id);
    const images = [answer, ...(answer?.previous ?? [])].flatMap((a) => a?.images ?? []);
    this.store.delete('answers', card.id);
    this.store.delete('cards', card.id);
    this.store.index(card.id, '');
    return [...(card.attachments ?? []), ...images].flatMap((f) => (f.id ? [f.id] : []));
  }

  /** GET /v1/state: a summary of each card the page shows, with the states, presence and levels. It reads only the
   * summaries, so its time grows with the cards on show, never with the size of their text or the cleared ones. */
  summaryState(): {
    cards: CardSummary[]; answers: Record<string, AnswerSummary>; presence: Record<string, Presence>; states: Record<string, CardState>;
    priorities: Record<string, string>; levels: PriorityLevel[]; settings: Settings; guidance: Guidance;
  } {
    const cards = this.store.list<CardSummary>('summaries').sort((a, b) => a.createdAt - b.createdAt);
    const answers: Record<string, AnswerSummary> = {};
    for (const c of cards) if (c.answer) answers[c.id] = c.answer;
    const presence = Object.fromEntries(this.store.list<Presence>('presence').map((p) => [p.agent, p]));
    const levels = this.priorities();
    const states: Record<string, CardState> = {};
    const priorities: Record<string, string> = {};
    for (const c of cards) {
      states[c.id] = this.shownState(c, presence[c.agent], c.answer);
      priorities[c.id] = this.effectivePriority(c, levels, c.answer);
    }
    return { cards, answers, presence, states, priorities, levels, settings: this.settings(), guidance: this.guidance() };
  }

  /** GET /v1/cards/<id>: the whole card, its answer, its state, and the rev of its summary. `owner` keeps what only the
   * person reads, such as the draft they left on a card they dismissed. */
  cardDetail(id: string, owner = false): { card: Card; answer?: Answer; state: CardState; rev?: string } {
    const card = this.getCard(id);
    const answer = this.store.get<Answer>('answers', id);
    // A body stored before the inbox checked bodies may not draw whole, so the client gets what it can draw.
    const fallback = card.body !== undefined ? this.fallbackBody?.(card.body) : undefined;
    const summary = this.store.get<CardSummary>('summaries', id);
    const shown = this.shownBroadcast(owner && card.closed ? { ...publicCard(card), closed: card.closed } : publicCard(card));
    return {
      card: fallback ? { ...shown, bodyFallback: fallback } : shown,
      ...(answer ? { answer } : {}),
      state: this.shownState(card, this.store.get<Presence>('presence', card.agent), answer),
      ...(summary ? { rev: summary.rev } : {}),
    };
  }

  /** Whether an open card's agent has left long ago, so another session can claim it. A row the sweep pruned counts as gone,
   * and so does a card whose agent never connected, once the card itself is old enough. */
  private orphaned(c: Card | CardSummary, s: CardState, p: Presence | undefined, now: number): boolean {
    if (s !== 'open' || c.deliver !== 'stream') return false;
    if (p) return !p.online && now - p.lastSeen > ORPHAN_MS;
    return now - (c.updatedAt ?? c.createdAt) > ORPHAN_MS;
  }

  /** A card's state, with orphaned for an open card whose agent left long ago: another session can claim it. */
  private shownState(c: Card | CardSummary, p: Presence | undefined, answer: Pick<Answer, 'savedAt' | 'readAt' | 'deliveredAt'> | undefined): CardState {
    return this.orphaned(c, cardState(c, answer), p, this.now()) ? 'orphaned' : cardState(c, answer);
  }

  state(): {
    cards: Card[]; answers: Record<string, Answer>; presence: Record<string, Presence>; states: Record<string, CardState>;
    priorities: Record<string, string>; levels: PriorityLevel[]; settings: Settings; guidance: Guidance;
  } {
    const cards = this.store.list<Card>('cards').filter((c) => !c.archivedAt).map((c) => this.shownBroadcast(publicCard(c))).sort((a, b) => a.createdAt - b.createdAt)
      // A body stored before the inbox checked bodies may not draw whole, so the page gets what it can draw.
      .map((c) => { const f = c.body !== undefined ? this.fallbackBody?.(c.body) : undefined; return f ? { ...c, bodyFallback: f } : c; });
    const shown = new Set(cards.map((c) => c.id));
    const answers = Object.fromEntries(this.store.list<Answer>('answers').filter((a) => shown.has(a.card)).map((a) => [a.card, a]));
    const presence = Object.fromEntries(this.store.list<Presence>('presence').map((p) => [p.agent, p]));
    const now = this.now();
    const states = Object.fromEntries(cards.map((c) => {
      const s = cardState(c, answers[c.id]);
      return [c.id, this.orphaned(c, s, presence[c.agent], now) ? 'orphaned' : s];
    }));
    const levels = this.priorities();
    // The answers are read already, so each card costs no storage read of its own.
    const priorities = Object.fromEntries(cards.map((c) => [c.id, this.effectivePriority(c, levels, answers[c.id])]));
    return { cards, answers, presence, states, priorities, levels, settings: this.settings(), guidance: this.guidance() };
  }
}

const TYPES_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', json: 'application/json',
  html: 'text/html', htm: 'text/html',
};

/** At most as many ids as a card's text links with [[card-id]]. */
const MAX_LOOKUP = 20;
const index = (i: number): number => i + 1;

/**
 * Before cards had `dialog`, the Claude Code AskUserQuestion hook was the only poster of `questions`, and the channel and
 * the herdr sidecar read `questions` as "this card has a terminal dialog". This marks each card that hook stored then, once
 * per inbox, so an answer on a card still open at the upgrade closes its dialog. The hook posts ids `ask-<8 hex digits>`.
 */
function markDialogCards(store: Storage): void {
  if (store.get<boolean>('meta', 'dialog-marked')) return;
  for (const c of store.list<Card>('cards')) {
    if (c.dialog === undefined && c.questions?.length && c.origin?.harness === 'claude-code' && /^ask-[0-9a-f]{8}$/.test(c.id)) store.put('cards', c.id, { ...c, dialog: true });
  }
  store.put('meta', 'dialog-marked', true);
}

/**
 * Each option with an id, as a stored card always carries one. `card_post` documents an option as `{label, description,
 * recommended}` and an agent may also post a plain label, so the inbox derives an id from the label when the post has
 * none: the label in lowercase, each run of other characters as one dash, and a number when two options share a label.
 * An id the agent gave stays as it is, and a derived id steps around every id the card already carries, so the ids
 * are unique. A card that carries an answer or a draft gets none: its pick names a label.
 */
/**
 * The same options for a card that carries an answer or a draft, which keeps the identity its pick names. No id is
 * derived here, and an option whose label a stored option had keeps that option's id, so a re-post that resends the
 * labels keeps the pick resolving.
 */
function withKeptOptionIds(options: Option[] | undefined, before: Card | undefined): Option[] | undefined {
  if (!Array.isArray(options) || !before?.options) return options;
  const byLabel = new Map(before.options.filter((o) => o && typeof o.id === 'string' && o.id).map((o) => [o.label, o.id!]));
  return options.map((o) => {
    if (!o || typeof o !== 'object' || (typeof o.id === 'string' && o.id)) return o;
    const id = byLabel.get(o.label);
    return id ? { ...o, id } : o;
  });
}

function withOptionIds(options: Option[] | undefined): Option[] | undefined {
  if (!Array.isArray(options)) return options;
  const taken = new Set<string>();
  for (const o of options) if (o && typeof o === 'object' && typeof o.id === 'string' && o.id) taken.add(o.id);
  return options.map((o, i) => {
    if (!o || typeof o !== 'object' || (typeof o.id === 'string' && o.id)) return o;
    const label = typeof o.label === 'string' ? o.label : '';
    const base = (label.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join('-').slice(0, 60) || `option-${index(i)}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return { ...o, id };
  });
}

/** The page draws each question from these fields, and the answer picks an option by its label, so two options with one label could not be told apart. */
function checkQuestions(questions: unknown): void {
  if (questions === undefined) return;
  if (!Array.isArray(questions)) throw new InboxError(400, 'questions must be a list of {question, text, options, multiSelect}');
  questions.forEach((q: Partial<AskQuestion> | null, i) => {
    const at = `question ${index(i)}`;
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) throw new InboxError(400, `${at}: question must be a non-empty string`);
    if (q.text !== undefined && typeof q.text !== 'string') throw new InboxError(400, `${at}: text must be a string`);
    if (q.options === undefined) return;
    if (!Array.isArray(q.options)) throw new InboxError(400, `${at}: options must be a list of {label, description, recommended}`);
    const labels = new Set<string>();
    for (const o of q.options) {
      if (!o || typeof o !== 'object' || typeof o.label !== 'string') throw new InboxError(400, `${at}: each option needs a label`);
      if (labels.has(o.label)) throw new InboxError(400, `${at}: two options have the label ${o.label}`);
      labels.add(o.label);
    }
    if (!q.multiSelect && q.options.filter((o) => o.recommended === true).length > 1) throw new InboxError(400, `${at}: a question without multiSelect takes at most one recommended option`);
  });
}

/** A cursor is where the next page starts in the matched list, encoded so a caller treats it as opaque. */
function writeCursor(offset: number): string {
  return btoa(String(offset));
}

function readCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  let offset = Number.NaN;
  try { offset = Number(atob(cursor)); } catch { /* a cursor this inbox never wrote */ }
  if (!Number.isInteger(offset) || offset < 0) throw new InboxError(400, 'cursor is not one this inbox gave out: start again without it');
  return offset;
}

/** The cards and URLs a card's text links: [[card-id]] references and http, https or file addresses. The `links`
 * filter matches a part of one of these, such as a pull request address. */
function cardLinks(card: Card): string[] {
  const text = `${card.title}\n${card.text ?? ''}\n${card.recommendation ?? ''}`;
  return [
    ...[...text.matchAll(/\[\[([\w.:-]{1,80})\]\]/g)].map((m) => m[1] as string),
    ...[...text.matchAll(/(?:https?|file):\/\/[^\s<>()[\]]+/g)].map((m) => m[0]),
  ];
}

function feedbackVerdict(v: unknown, field: string): FeedbackVerdict {
  if (typeof v !== 'string' || !FEEDBACK_VERDICTS.has(v)) throw new InboxError(400, `${field} must be agree, disagree or partly`);
  return v as FeedbackVerdict;
}

/** A text field of feedback, trimmed, or undefined when empty. Too long is refused rather than cut, so the record is
 * what the agent wrote. */
function cappedText(v: unknown, max: number, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  const text = String(v).trim();
  if (text.length > max) throw new InboxError(400, `${field} must be at most ${max} characters`);
  return text || undefined;
}

function checkFeedbackFilter(f: SearchFilters['triageFeedback']): void {
  if (f !== undefined && f !== 'any' && !FEEDBACK_VERDICTS.has(f)) throw new InboxError(400, 'triage_feedback must be any, agree, disagree or partly');
}

/** Whether any pushback on the card carries feedback, or feedback with this verdict. No filter keeps every card. */
function hasFeedback(card: Card, f: SearchFilters['triageFeedback']): boolean {
  if (f === undefined) return true;
  return (card.pushback ?? []).some((p) => p.feedback && (f === 'any' || p.feedback.verdict === f));
}

/** How a card triage pushed back on ended: the person answered it, triage let a later version through, it is still
 * sent back, or it closed another way. */
function laterOutcome(card: Card, answer: Answer | undefined): string {
  if (answer) return 'answered';
  if (card.closed) return card.closed.kind;
  if (card.triage?.state === 'passed' || card.triage?.state === 'skipped') return 'passed';
  return card.triage?.state ?? 'open';
}

/** The text search matches: the card's words, its tags, and its file names. */
function searchText(card: Card): string {
  // A card stored before this field existed may hold anything the store accepted then, so read it defensively.
  const questions = (Array.isArray(card.questions) ? card.questions : []).flatMap((q) => [q?.question, q?.text, ...(Array.isArray(q?.options) ? q.options : []).map((o) => o?.label)]);
  return [card.title, card.text, card.recommendation, card.body, ...questions, card.status, ...Object.entries(card.tags ?? {}).map(([k, v]) => `${k} ${v}`), ...(card.attachments ?? []).map((a) => a.name)]
    .filter(Boolean).join('\n');
}

/** The line `widgetCatalog()` puts above its bullets, spelled once so the cleaner recognizes the catalog it writes. */
const CATALOG_HEADER = 'Widgets you can place in a card body with a line `part = widget <name> {json values}`:';

/** The line `card_guidance` puts above the catalog, and the one it puts above the tag values. Neither is guidance. */
const ADDED_BESIDE_GUIDANCE = /^Not part of the guidance text(?: either)?, (?:added to this answer: the widget catalog\.|tag values in use:)$/;

/** One line of tag values as `card_guidance` prints it: `key` = value (2), value (1). */
const TAG_VALUE_LINE = /^`[^`\n]+` = .*\(\d+\)\.$/;

/**
 * The guidance text alone. The widget catalog and the tag values reach an agent beside the text, so neither belongs
 * in it: a proposal that pastes a whole `card_guidance` answer keeps the words the agent wrote, and an inbox that
 * stored such a paste repairs its guidance on the first read. The catalog block is found by the header above it, and
 * the tag lines by their marker, so a widget that changes later does not change how an old text reads. `catalog`
 * drops that catalog's bullets on their own too, for a paste that kept the list and left the header behind.
 */
export function guidanceTextOnly(text: string, catalog?: string): string {
  const bullets = new Set((catalog ?? '').split('\n').slice(1).filter((l) => l.trim()));
  const kept: string[] = [];
  let inCatalog = false;
  let tagValues = false;
  for (const line of String(text ?? '').split('\n')) {
    if (line === CATALOG_HEADER) { inCatalog = true; tagValues = false; continue; }
    if (ADDED_BESIDE_GUIDANCE.test(line)) { inCatalog = false; tagValues = line.endsWith('tag values in use:'); continue; }
    if (bullets.has(line)) { inCatalog = false; tagValues = false; continue; }
    // The catalog is the bullets under its header, and the tag values are the lines under their marker. Any other
    // line ends the block and is kept, so a blank line or a new paragraph after it survives as it was written.
    if (inCatalog) { if (/^- /.test(line)) continue; inCatalog = false; }
    if (tagValues) { if (TAG_VALUE_LINE.test(line)) continue; tagValues = false; }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** The edits of a guidance proposal, checked for shape: a list of {old, new}, each old a passage to find. */
function checkGuidanceEdits(edits: unknown): GuidanceEdit[] {
  if (!Array.isArray(edits) || !edits.length) throw new InboxError(400, 'edits must be a list of {old, new}');
  return edits.map((e, i) => {
    const old = typeof e?.old === 'string' ? e.old : '';
    if (!old) throw new InboxError(400, `edit ${i + 1}: old must be the passage of the guidance to replace`);
    if (typeof e?.new !== 'string') throw new InboxError(400, `edit ${i + 1}: new must be a string, empty to delete the passage`);
    // An edit that changes nothing is a mistake rather than a proposal, as it is for card_patch.
    if (e.new === old) throw new InboxError(400, `edit ${i + 1}: new is identical to old, so it changes nothing`);
    return { old, new: e.new };
  });
}

/** The guidance with each edit applied in turn, the way card_patch edits a card: each old text must occur exactly once
 * in the text so far, or the whole proposal fails with the number of the edit that missed. */
export function editGuidance(guidance: Pick<Guidance, 'text' | 'version'>, edits: GuidanceEdit[]): string {
  let text = guidance.text;
  for (const [i, e] of edits.entries()) {
    const count = text.split(e.old).length - 1;
    if (count !== 1) {
      const near = count === 0 ? nearestLines(text, e.old) : [];
      const hint = near.length ? `; the closest lines are ${near.map((l) => JSON.stringify(l)).join(', ')}` : '';
      throw new InboxError(409, `edit ${i + 1}: the old text occurs ${count} times in guidance version ${guidance.version}, and it must occur once${hint}`);
    }
    text = text.replace(e.old, () => e.new);
  }
  return text;
}

/** A passage as a Markdown quote, so the card's text shows each edit apart from the words around it. */
function quote(text: string): string {
  return text ? text.split('\n').map((l) => `> ${l}`).join('\n') : '_(nothing)_';
}

const ORIGIN_FIELDS = ['harness', 'session', 'name', 'host', 'cwd', 'herdrPane', 'herdrWorkspace', 'herdrTab'] as const;

/** The origin fields a presence row keeps: what labels a session on a card, and what opens its pane. */
const PRESENCE_ORIGIN_FIELDS = ['harness', 'session', 'name', 'host', 'herdrPane'] as const;

/** A post's tags as the merge reads them: an object of values, or nothing. A client that sends anything else keeps the
 * tags it sent on the card, as it always did. */
function ownTags(tags: unknown): Record<string, string> | undefined {
  return tags && typeof tags === 'object' && !Array.isArray(tags) ? (tags as Record<string, string>) : undefined;
}

/** One pull request an agent names on a card: the owner, the repo and the number, and nothing else. The identifier is
 * all the inbox keeps, because GitHub holds the title, the address and the state, and they go stale here. */
function checkPullRequest(raw: unknown, at: string): PullRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InboxError(400, `${at} must be an object with owner, repo and number`);
  const extra = Object.keys(raw as object).filter((k) => k !== 'owner' && k !== 'repo' && k !== 'number');
  if (extra.length) throw new InboxError(400, `${at} takes only owner, repo and number, and names ${extra.join(', ')}`);
  const fields = raw as Record<string, unknown>;
  for (const key of ['owner', 'repo'] as const) {
    const v = fields[key];
    if (typeof v !== 'string' || !/^[\w.-]{1,100}$/.test(v)) throw new InboxError(400, `${at}.${key} must be 1 to 100 letters, digits, dots, dashes or underscores`);
  }
  const number = fields['number'];
  if (!Number.isInteger(number) || (number as number) < 1) throw new InboxError(400, `${at}.number must be a positive whole number`);
  return { owner: fields['owner'] as string, repo: fields['repo'] as string, number: number as number };
}

/** The pullRequests field as a card post gives it: one object, or an array of 1 to 20. The shape is stored as given, so
 * a reader sees whether the card names one pull request or several. An empty array or object names nothing, and is a 400. */
function checkPullRequests(raw: unknown): PullRequest | PullRequest[] {
  if (Array.isArray(raw)) {
    if (!raw.length) throw new InboxError(400, `pullRequests must name 1 to ${MAX_PULL_REQUESTS} pull requests, and the array is empty`);
    if (raw.length > MAX_PULL_REQUESTS) throw new InboxError(400, `pullRequests takes at most ${MAX_PULL_REQUESTS} pull requests, and this list has ${raw.length}`);
    return raw.map((r, i) => checkPullRequest(r, `pullRequests[${i}]`));
  }
  return checkPullRequest(raw, 'pullRequests');
}

/** The origin fields the page knows, each a string of at most 200 characters. */
function cleanOrigin(origin: unknown): Origin | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const out: Origin = {};
  for (const k of ORIGIN_FIELDS) {
    const v = (origin as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && v !== '') out[k] = String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The origin a connection reports, as its presence row keeps it: the fields that label the session and open its pane. */
export function connectionOrigin(origin: unknown): PresenceOrigin | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const out: PresenceOrigin = {};
  for (const k of PRESENCE_ORIGIN_FIELDS) {
    const v = (origin as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && v !== '') out[k] = String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

/** What herdr said about a pane, as short strings, or undefined when it said nothing. */
function cleanPlace(place: unknown): ApprovalPlace | undefined {
  if (!place || typeof place !== 'object') return undefined;
  const out: ApprovalPlace = {};
  for (const k of ['agent', 'title', 'tab', 'workspace'] as const) {
    const v = (place as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 120);
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanName(name: unknown): string {
  return name ? String(name).replace(/[\\/\x00-\x1f]/g, '_').slice(0, 120) : '';
}

function decodeDataUrl(i: number, f: NewAttachment): { type: string; bytes: Uint8Array<ArrayBuffer> } {
  const m = /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(f.src));
  if (!m) throw new InboxError(400, `attachment ${i + 1}: src must be an https URL or a base64 data: URL`);
  const data = (m[2] ?? '').replace(/\s/g, '');
  const size = Math.floor((data.length * 3) / 4);
  if (size > MAX_ATTACHMENT_BYTES + 2) throw new InboxError(413, `attachment ${i + 1}${f.name ? ` (${cleanName(f.name)})` : ''} is ${size} bytes, over the limit of ${MAX_ATTACHMENT_BYTES}`);
  let raw: string;
  try { raw = atob(data); } catch { throw new InboxError(400, `attachment ${i + 1}: the base64 data is malformed`); }
  // A loop, not `Uint8Array.from(raw, ...)`: the callback that form calls once per byte is most of the time this route
  // spends on a large screenshot.
  const bytes = new Uint8Array(raw.length);
  for (let k = 0; k < raw.length; k++) bytes[k] = raw.charCodeAt(k);
  return { type: (m[1] ?? '').toLowerCase(), bytes };
}

/** The type of a file by its extension, or application/octet-stream for an extension the inbox does not know. */
export function typeFromName(name: string): string {
  return TYPES_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** A file's type, or the type its name gives when an agent sent it as application/octet-stream. */
export function attachmentType(file: { name: string; type?: string }): string {
  return !file.type || file.type === 'application/octet-stream' ? typeFromName(file.name) : file.type;
}

/** A webhook address the inbox calls: https only, as for the owner's webhooks. */
function webhookUrl(url: unknown): string {
  const text = String(url ?? '');
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new InboxError(400, 'webhook.url must be an https URL'); }
  if (parsed.protocol !== 'https:') throw new InboxError(400, 'webhook.url must be https');
  if (text.length > 2000) throw new InboxError(400, 'webhook.url must be at most 2,000 characters');
  // A backtick is the one URL character that ends a code span on the card, and %60 is the same address.
  return parsed.href.replace(/`/g, '%60');
}

/** The headers a client sends with each call: names a header can have, values on one line, and none the inbox sets itself. */
function webhookHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) throw new InboxError(400, 'webhook.headers must be an object of header names and values');
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_WEBHOOK_HEADERS) throw new InboxError(400, `webhook.headers takes at most ${MAX_WEBHOOK_HEADERS} headers`);
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (seen.has(name.toLowerCase())) throw new InboxError(400, `webhook header ${name}: given twice, in two cases`);
    seen.add(name.toLowerCase());
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) throw new InboxError(400, `webhook header ${JSON.stringify(name.slice(0, 64))}: not a header name`);
    if (RESERVED_HEADER.test(name)) throw new InboxError(400, `webhook header ${name}: the inbox sets it itself`);
    const v = String(value ?? '');
    if (/[\r\n\0]/.test(v) || v.length > 2000) throw new InboxError(400, `webhook header ${name}: the value must be one line of at most 2,000 characters`);
    out[name] = v;
  }
  return out;
}

/** A card without what only the person reads: the id of the token that posted it, and the draft they left on a card
 * they dismissed. */
export function publicCard(card: Card): Card {
  const { token: _token, pushed: _pushed, ...rest } = card;
  if (!rest.closed?.draft) return rest;
  const { kind, outcome, at } = rest.closed;
  return { ...rest, closed: { kind, outcome, at } };
}

/** Whether the person already had this card, so a revision of it never pushes. A card stored before pushes existed has no
 * mark, and the person had it, unless triage still screens it, holds it or sent it back. */
function hadReached(card: Card): boolean {
  if (card.pushed) return true;
  const t = card.triage?.state;
  return t !== 'pending' && t !== 'held' && t !== 'returned' && card.closed?.kind !== 'returned';
}

/** The stored lines that share the most words with a text that matched nothing, so an error can name what is there. */
function nearestLines(text: string, old: string): string[] {
  const words = [...new Set(old.toLowerCase().split(/\s+/).filter((w) => w.length >= 3))].slice(0, 8);
  if (!words.length) return [];
  return text.split('\n')
    .map((line) => ({ line: line.trim(), score: words.filter((w) => line.toLowerCase().includes(w)).length }))
    .filter((c) => c.line !== '' && c.score > 0)
    .sort((a, b) => b.score - a.score || b.line.length - a.line.length)
    .slice(0, 3)
    .map((c) => c.line.slice(0, 180));
}
