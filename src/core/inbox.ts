// The inbox: every change to cards, answers, presence and tokens goes through
// this one object. Storage calls are synchronous, so each change completes
// before the next starts. Every change is written to storage before a method
// returns, and memory holds only the open connections.
import { newSecret, pairingCode, randomId, sha256 } from './crypto.ts';
import { parse, test as testRule, type Value } from './expr.ts';
import { HOOK_VERSION, HOOKS, deliverWebhook, isHook, type ExtensionRegistration, type HookEvent, type HookName, type Verdict, type Webhook } from './hooks.ts';
import { isSealed } from './sealed.ts';
import { checkDiagrams, findDiagrams, requireChecked, type CheckedDiagrams, type DiagramCheck } from './diagrams.ts';
import { BUILTIN_WIDGETS, distinctWidgets, expandWidgets, fill, respond, type WidgetSource } from './widgets.ts';
import { PinLock } from './pin.ts';
import { MemoryBlobs, type BlobStore, type Storage } from './storage.ts';
import { Usage } from './telemetry.ts';
import type {
  AgentEvent, Answer, Card, CardState, CardVersion, CloseKind, Delivery, Guidance, NewCard, Origin, PageEvent, Pairing, Presence,
  Attachment, NewAttachment, PersonPresence, PriorityLevel, Role, Settings, Template, Token,
} from './types.ts';

export class InboxError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Caller {
  token: string;
  role: Role;
}

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
  /** The inbox always counts usage and has no off switch, as on the hosted service. */
  usageAlwaysOn?: boolean;
}

export const SYSTEM_AGENT = 'system';
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 5;
const CLOSE_KINDS = new Set<CloseKind>(['retracted', 'self-answered', 'answered-in-terminal', 'resolved']);
const HISTORY_LIMIT = 20;
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
export const DEFAULT_GUIDANCE = [
  'Write each card so the person can answer it without opening the session.',
  'State the goal, the options you weighed, the evidence, and your recommendation.',
  'Shape the answer options to the question. The person may leave any field empty.',
  'Put each question next to the field that answers it. One question uses options. Several questions use forms in the body, each beside the text or table it is about.',
  'Explain each option inside it, in its description: what you will do if the person picks it. Never list the options with their explanations in the text.',
  'Never list questions in the text with the answers at the bottom. Write what you will check yourself as statements, not questions.',
  'The page adds a comment box, Send answer and Skip at the bottom of every card. Add no general comment box or send button of your own.',
  'When a card asks several questions, give each one its own short comment field beside it, so the person can say why for that question alone.',
  'When a card is about another agent, link its session so the person can go there in one click: [label](https://herdr.invalid/v1/pane/<pane id>), from `herdr agent list`. Link another card with [[card-id]].',
  'Search earlier answers before you post, and never ask the same thing twice.',
].join('\n');
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Each stored file counts as at least this many bytes toward the upload limit, so tiny files cannot make unlimited blob writes. */
export const MIN_FILE_CHARGE = 64 * 1024;
/** The largest card, as stored, without its files. */
export const MAX_CARD_BYTES = 256 * 1024;
export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_FROM_CHARS = 80;
export const MAX_VERSIONS = 50;
export const MAX_REPLY_BYTES = 4096;
export const MAX_REPLIES = 200;
export const MAX_WEBHOOKS = 5;
/** How long a sign-in code from the phone dialog works. */
export const SIGN_IN_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_SIGN_IN_CODES = 5;
/** How long a closed pairing request and its card stay before the sweep deletes them. */
export const PAIRING_KEEP_MS = 24 * 60 * 60 * 1000;

const PATCH_FIELDS = new Set(['title', 'text', 'body', 'html', 'recommendation']);
const DELIVERIES = new Set<Delivery>(['default', 'steer', 'followUp', 'force']);

/** A card's state follows from its closure and its answer. */
export function cardState(card: Card, answer: Answer | undefined): CardState {
  // An answer saved after the agent closed the card still goes to the agent.
  if (card.closed && !(answer && answer.savedAt > card.closed.at)) return 'closed';
  if (!answer && card.triage?.state === 'pending') return 'in-triage';
  if (!answer && card.triage?.state === 'held') return 'held';
  if (!answer) return 'open';
  if (answer.readAt) return 'read';
  if (answer.deliveredAt) return 'delivered';
  return 'answered';
}

type AgentSend = (ev: AgentEvent) => void;
type PageSend = (ev: PageEvent) => void;

export class Inbox {
  private readonly store: Storage;
  private readonly blobs: BlobStore;
  private readonly uploadLimit: number | undefined;
  private readonly storageLimit: number | undefined;
  private readonly readsPerDay: number | undefined;
  private readonly checkDiagram: DiagramCheck | undefined;
  private readonly checkBody: ((body: string) => string[]) | undefined;
  private readonly fallbackBody: ((body: string) => Card['bodyFallback']) | undefined;
  private readonly now: () => number;
  private readonly agents = new Map<string, Set<AgentSend>>();
  private readonly instances = new WeakMap<AgentSend, string>();
  private readonly pages = new Set<PageSend>();
  /** The pages that need an unlock token, with the one they opened with and how to close them. */
  private readonly guarded = new Map<PageSend, { unlock: string | undefined; close: () => void }>();
  /** What each open page reports about the person, by page id. */
  private readonly viewers = new Map<string, { visible: boolean; activeAt: number | null; focus: string | null }>();
  private readonly extensions = new Map<string, { reg: ExtensionRegistration; token: string; send: (ev: HookEvent) => void }>();
  /** Webhook deliveries still running, so tests and shutdown can wait for them. */
  readonly deliveries = new Set<Promise<boolean>>();
  /** The usage counts the platform sends once a day, when the person left them on. */
  readonly usage: Usage;
  /** The PIN a browser tab types before it acts as the owner. */
  readonly pin: PinLock;

  /** `keepPresence` is for a platform whose sockets outlive the object, such as a Durable Object that wakes from hibernation.
   * `uploadLimitBytes` caps the bytes of every file this inbox ever stores. Deleting a file gives none back.
   * `storageLimitBytes` caps what the inbox keeps in its storage now. A full inbox takes only writes that free space.
   * `attachmentReadsPerDay` caps how many files the inbox serves in a day. */
  constructor(store: Storage, now: () => number = Date.now, blobs: BlobStore = new MemoryBlobs(), opts: InboxOptions = {}) {
    this.store = store;
    this.now = now;
    this.blobs = blobs;
    this.uploadLimit = opts.uploadLimitBytes;
    this.storageLimit = opts.storageLimitBytes;
    this.readsPerDay = opts.attachmentReadsPerDay;
    this.checkDiagram = opts.checkDiagram;
    this.checkBody = opts.checkBody;
    this.fallbackBody = opts.fallbackBody;
    this.usage = new Usage(store, now, { alwaysOn: opts.usageAlwaysOn });
    this.pin = new PinLock(store, now, opts.pinIterations);
    // A page that opened before the PIN changed must unlock again.
    this.pin.onChange(() => this.closeLockedPages());
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
    for (const p of this.store.list<Presence>('presence')) if (p.online && p.leftAt !== undefined) times.push(p.leftAt + PRESENCE_GRACE_MS);
    for (const p of this.store.list<Pairing>('pairings')) {
      times.push(p.status === 'pending' || p.secret ? p.createdAt + PAIRING_TTL_MS : p.createdAt + PAIRING_KEEP_MS);
    }
    for (const c of this.store.list<Card>('cards')) {
      if (c.triage?.state === 'pending' && c.triage.deadline) times.push(c.triage.deadline);
      if (c.expiresAt && !c.closed && !this.store.get('answers', c.id)) times.push(c.expiresAt);
    }
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

  revokeToken(id: string): void {
    if (!this.store.get('tokens', id)) throw new InboxError(404, 'unknown token');
    this.store.delete('tokens', id);
    this.pin.dropUnlocks(id);
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
  createSignInCode(caller: Caller): { code: string; expiresAt: number } {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner signs a device in');
    const now = this.now();
    const live = this.signInCodes().filter((c) => {
      if (c.expiresAt > now) return true;
      this.store.delete('meta', c.key);
      return false;
    });
    if (live.length >= MAX_SIGN_IN_CODES) throw new InboxError(429, 'too many sign-in codes are waiting; wait five minutes');
    const code = randomId(16);
    const expiresAt = now + SIGN_IN_CODE_TTL_MS;
    this.store.put('meta', `signin:${code}`, { key: `signin:${code}`, expiresAt });
    return { code, expiresAt };
  }

  /** A device turns a sign-in code into its own owner token. Each code works once. */
  async redeemSignInCode(code: string): Promise<{ secret: string }> {
    const key = `signin:${String(code ?? '')}`;
    const found = /^signin:[0-9a-f]{32}$/.test(key) ? this.store.get<{ key: string; expiresAt: number }>('meta', key) : undefined;
    if (found) this.store.delete('meta', key);
    if (!found || found.expiresAt <= this.now()) throw new InboxError(401, 'this sign-in code is not valid or has expired; scan a new one');
    const { secret } = await this.createToken(`device signed in ${new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ')}`, 'owner');
    return { secret };
  }

  private signInCodes(): { key: string; expiresAt: number }[] {
    return this.store.list<{ key?: unknown; expiresAt?: unknown }>('meta')
      .filter((m): m is { key: string; expiresAt: number } => typeof m?.key === 'string' && m.key.startsWith('signin:'));
  }

  /** A client asks to pair. The person sees a system card with the code. */
  requestPairing(name: string, role: Role): Pairing {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new InboxError(400, 'name is required');
    if (role !== 'agent' && role !== 'owner' && role !== 'extension') throw new InboxError(400, 'role must be agent, owner or extension');
    const pending = this.store.list<Pairing>('pairings').filter((p) => p.status === 'pending');
    if (pending.length >= MAX_PENDING_PAIRINGS) throw new InboxError(429, 'too many pairing requests are waiting');
    const pairing: Pairing = { id: randomId(8), name: clean, role, code: pairingCode(), status: 'pending', createdAt: this.now() };
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

  /** `checked` holds what checkCard found for the card's diagrams. A card with a diagram it does not hold is refused. */
  postCard(caller: Caller, input: NewCard, storedFiles?: Set<string>, checked?: CheckedDiagrams): Card {
    if (!input || typeof input !== 'object') throw new InboxError(400, 'card must be an object');
    const title = String(input.title ?? '').trim();
    if (!title) throw new InboxError(400, 'title is required');
    const agent = String(input.agent ?? '').trim();
    if (!agent) throw new InboxError(400, 'agent is required');
    if (agent.length > 80) throw new InboxError(400, 'agent must be at most 80 characters');
    if (title.length > 300) throw new InboxError(400, 'title must be at most 300 characters');
    if (agent === SYSTEM_AGENT && caller.token !== '') throw new InboxError(403, 'the system agent is reserved');
    const levels = this.priorities();
    const priority = input.priority ?? (levels.some((l) => l.id === 'soon') ? 'soon' : levels[0]?.id ?? 'soon');
    if (!levels.some((l) => l.id === priority)) throw new InboxError(400, `priority must be one of ${levels.map((l) => l.id).join(', ')}`);
    if (input.rating !== undefined && !(Number.isInteger(input.rating) && input.rating >= 1 && input.rating <= 5)) throw new InboxError(400, 'rating must be 1 to 5');
    const id = input.id ? String(input.id) : randomId(8);
    if (!/^[\w.:-]{1,80}$/.test(id)) throw new InboxError(400, 'id must be 1 to 80 letters, digits, dots, colons, dashes or underscores');

    const kind = input.kind ?? 'ask';
    if (kind === 'secret') {
      const s = input.secret;
      if (!s || typeof s !== 'object' || !s.publicKey || typeof s.publicKey !== 'object') throw new InboxError(400, 'a secret card needs secret.name and secret.publicKey');
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(s.name ?? ''))) throw new InboxError(400, 'secret.name must be a variable name, such as API_KEY');
      if (s.publicKey.kty !== 'RSA') throw new InboxError(400, 'secret.publicKey must be an RSA-OAEP key');
    }

    const now = this.now();
    const before = this.store.get<Card>('cards', id);
    if (before && before.token !== caller.token && caller.role !== 'owner') throw new InboxError(403, 'another client owns this card');
    const { body, template, expanded } = this.cardBody(input);
    // The page drops what it cannot read of a body without a word, so the agent hears it here.
    const bodyProblems = body === undefined || !this.checkBody ? [] : this.checkBody(String(body));
    if (bodyProblems.length) throw new InboxError(400, `the page cannot draw all of this body:\n- ${bodyProblems.join('\n- ')}`);
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
    const card: Card = {
      id,
      agent,
      token: before?.token ?? caller.token,
      kind,
      title,
      text: input.text,
      recommendation: input.recommendation,
      body,
      options: input.options,
      multiple: input.multiple,
      questions: input.questions,
      screen: input.screen,
      secret: kind === 'secret' ? { name: String(input.secret?.name), publicKey: (input.secret?.publicKey ?? {}) as JsonWebKey } : undefined,
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
      history: history.length ? history : undefined,
      broadcast: before?.broadcast,
      origin: cleanOrigin(input.origin),
      from: input.from === undefined || input.from === null ? undefined : String(input.from).trim().slice(0, MAX_FROM_CHARS) || undefined,
      tags: input.tags,
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
    if (kind !== 'system' || caller.token !== '') requireChecked(findDiagrams(card), checked);
    // Replies and history have their own caps, so a card with many replies can still be revised.
    const size = new TextEncoder().encode(JSON.stringify({ ...card, history: undefined, replies: undefined })).length;
    if (size > MAX_CARD_BYTES) throw new InboxError(413, `the card is ${size} bytes, over the limit of ${MAX_CARD_BYTES}. Attach large content as a file`);
    this.store.put('cards', id, card);
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
    // Agent cards go through the card.created hook before the person sees them.
    if ((kind === 'ask' || kind === 'secret') && caller.token !== '') return this.requestTriage(card);
    return card;
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
    if (body === undefined) return { body, template };
    const expanded = expandWidgets(String(body), (name, version) => this.widgetVersion(name, version));
    return { body: expanded.body, template, expanded };
  }

  /** Parse every diagram the card would show, before the card commits. An await sits here, so the commit reads everything again. */
  private checkCard(input: NewCard): Promise<CheckedDiagrams> {
    return checkDiagrams(findDiagrams({ text: input.text, recommendation: input.recommendation, body: this.cardBody(input).body }), this.checkDiagram);
  }

  // ---- extensions and hooks ----

  /** An extension dials in for the hooks it names. A second connection with the same name replaces the first. */
  connectExtension(caller: Caller, reg: Partial<ExtensionRegistration>, send: (ev: HookEvent) => void): () => void {
    const entry = { reg: this.checkExtension(caller, reg), token: caller.token, send };
    const name = entry.reg.name;
    this.extensions.set(name, entry);
    // Screen the cards that came in while no extension was there.
    if (entry.reg.hooks.includes('card.created')) {
      for (const card of this.store.list<Card>('cards')) {
        if ((card.kind !== 'ask' && card.kind !== 'secret') || card.closed || this.store.get('answers', card.id)) continue;
        const t = card.triage;
        if (t?.state === 'pending' && t.request && t.deadline && t.waiting?.includes(name)) {
          // A call this extension missed while it reconnected.
          send({ type: 'hook', version: HOOK_VERSION, id: t.request, hook: 'card.created', card: publicCard(card), deadline: t.deadline, person: this.person() });
        } else if (!t || t.state === 'skipped' || (t.state === 'pending' && !t.waiting?.length)) this.requestTriage(card);
      }
    }
    return () => { if (this.extensions.get(name) === entry) this.extensions.delete(name); };
  }

  /** Check and complete an extension registration without connecting it. */
  checkExtension(caller: Caller, reg: Partial<ExtensionRegistration>): ExtensionRegistration {
    if (caller.role === 'agent') throw new InboxError(403, 'only an extension or owner token can register hooks');
    const name = String(reg.name ?? '').trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new InboxError(400, 'name must be 1 to 40 letters, digits, dots, dashes or underscores');
    const hooks = (reg.hooks ?? []).map(String);
    if (!hooks.length || !hooks.every(isHook)) throw new InboxError(400, `hooks must name some of ${Object.keys(HOOKS).join(', ')}`);
    const policy = reg.policy === 'fail-closed' ? 'fail-closed' : 'fail-open';
    const asked = Number(reg.timeoutMs);
    const timeoutMs = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : HOOKS['card.created'].defaultTimeoutMs, 1000), 600_000);
    return { name, hooks: hooks as HookName[], policy, timeoutMs };
  }

  private requestTriage(card: Card): Card {
    const targets = [...this.extensions.values()].filter((e) => e.reg.hooks.includes('card.created'));
    const now = this.now();
    if (!targets.length) {
      // Fail-open when triage is down: the card goes straight to the person, and a returning extension screens it.
      const next = { ...card, triage: { state: 'skipped' as const, reason: 'No triage extension was connected.', at: now } };
      this.store.put('cards', card.id, next);
      return next;
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

  /** An extension answers a card.created call. */
  hookVerdict(caller: Caller, request: string, verdict: Verdict, reason: string): Card {
    const card = this.store.list<Card>('cards').find((c) => c.triage?.request === request);
    if (!card?.triage) throw new InboxError(404, 'unknown hook call');
    const ext = [...this.extensions.values()].find((e) => e.token === caller.token && card.triage?.waiting?.includes(e.reg.name));
    if (!ext) throw new InboxError(403, 'this hook call does not wait for this extension');
    if (!(HOOKS['card.created'].verdicts as readonly string[]).includes(verdict)) throw new InboxError(400, 'verdict must be pass, hold or return');
    if (card.triage.state !== 'pending') return card;
    const clean = String(reason ?? '').slice(0, 1000);
    const waiting = (card.triage.waiting ?? []).filter((n) => n !== ext.reg.name);
    const now = this.now();
    if (verdict === 'return') {
      this.store.put('cards', card.id, { ...card, triage: { ...card.triage, state: 'returned', by: ext.reg.name, reason: clean, waiting: [], at: now } });
      this.closeAs(card, 'returned', clean || 'Triage sent the card back.');
      for (const [k, subs] of this.agents) {
        if (k === this.key(card.token ?? '', card.agent)) for (const send of subs) send({ type: 'returned', id: randomId(6), card: publicCard(card), reason: clean || 'Triage sent the card back.' });
      }
      return this.getCard(card.id);
    }
    const triage = verdict === 'hold'
      ? { ...card.triage, state: 'held' as const, by: ext.reg.name, reason: clean, waiting: [], at: now }
      : { ...card.triage, state: waiting.length ? 'pending' as const : 'passed' as const, waiting, reason: clean || card.triage.reason, at: now };
    const next = { ...card, triage };
    this.store.put('cards', card.id, next);
    this.emit({ type: 'change', card: card.id });
    return next;
  }

  /** The owner lets a held card through. */
  release(id: string): Card {
    const card = this.getCard(id);
    if (!card.triage || card.triage.state !== 'held') return card;
    const next = { ...card, triage: { ...card.triage, state: 'passed' as const, reason: `Released by you. ${card.triage.reason ?? ''}`.trim(), at: this.now() } };
    this.store.put('cards', id, next);
    this.emit({ type: 'change', card: id });
    return next;
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
    const event: HookEvent = { type: 'hook', version: HOOK_VERSION, id: randomId(8), hook: 'answer.saved', card: publicCard(card), answer };
    for (const e of this.extensions.values()) if (e.reg.hooks.includes('answer.saved')) e.send(event);
    for (const w of this.webhooks().filter((x) => x.hook === 'answer.saved')) {
      const p = deliverWebhook(w, event);
      this.deliveries.add(p);
      void p.then(() => this.deliveries.delete(p), () => this.deliveries.delete(p));
    }
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
    const checked = await this.checkCard(input);
    const files = input.attachments;
    if (!Array.isArray(files) || !files.some((f) => /^data:/.test(String(f?.src ?? '')))) return this.postCard(caller, input, undefined, checked);
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
    const refund = async (): Promise<void> => {
      await Promise.all(stored.map((f) => this.blobs.delete(f.id ?? '')));
      this.store.put('meta', 'uploaded-bytes', Math.max(0, this.uploads().used - bytes));
    };
    // Wait for every put, so a put that fails leaves none of the others behind. Each key is listed before its put starts.
    const settled = await Promise.allSettled(files.map(async (f, i): Promise<NewAttachment> => {
      const d = decoded[i];
      if (!d) return f;
      const key = `${id}.${i}.${randomId(6)}`;
      const ref: Attachment = { id: key, name: cleanName(f.name) || `attachment-${i + 1}`, type: d.type, size: d.bytes.length, alt: f.alt ? String(f.alt).slice(0, 300) : undefined };
      stored.push(ref);
      await this.blobs.put(key, d.bytes, d.type);
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
      card = this.postCard(caller, { ...input, id, attachments: resolved }, new Set(stored.map((f) => f.id ?? '')), checked);
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
    const file = card.attachments?.find((f) => f.id === id);
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
  patchCard(caller: Caller, id: string, edits: { old: string; new: string }[], field?: string, checked?: CheckedDiagrams): Card {
    const { card, input } = this.patched(caller, id, edits, field);
    const next = this.postCard(caller, input, undefined, checked);
    // A patch edits the body the widgets already filled, so the card still shows them and keeps their responses, and any the patch placed.
    if (!card.widgets) return next;
    const responses = [...(card.responses ?? []), ...(next.responses ?? [])];
    const kept = { ...next, widgets: distinctWidgets([...card.widgets, ...(next.widgets ?? [])]), ...(responses.length ? { responses } : {}) };
    this.store.put('cards', kept.id, kept);
    return kept;
  }

  /** patchCard, with the diagrams of the patched card checked first. */
  async patchCardChecked(caller: Caller, id: string, edits: { old: string; new: string }[], field?: string): Promise<Card> {
    const checked = await this.checkCard(this.patched(caller, id, edits, field).input);
    return this.patchCard(caller, id, edits, field, checked);
  }

  /** The card a patch would post, and the card it edits. */
  private patched(caller: Caller, id: string, edits: { old: string; new: string }[], field?: string): { card: Card; input: NewCard } {
    const card = this.owned(caller, id);
    const f = field ?? (card.body !== undefined ? 'body' : card.html !== undefined ? 'html' : 'text');
    if (!PATCH_FIELDS.has(f)) throw new InboxError(400, `field must be one of ${[...PATCH_FIELDS].join(', ')}`);
    if (!Array.isArray(edits) || !edits.length) throw new InboxError(400, 'edits must be a list of {old, new}');
    let text = String((card as unknown as Record<string, unknown>)[f] ?? '');
    for (const [i, e] of edits.entries()) {
      const old = String(e?.old ?? '');
      // An empty old text fills a field that is empty.
      if (!old && !text) { text = String(e.new ?? ''); continue; }
      const count = old ? text.split(old).length - 1 : 0;
      if (count !== 1) throw new InboxError(409, `edit ${i + 1}: the old text occurs ${count} times in ${f}, and it must occur once`);
      text = text.replace(old, () => String(e.new ?? ''));
    }
    const { token: _t, version: _v, createdAt: _c, updatedAt: _u, closed: _cl, replies: _r, history: _h, triage: _tr, followedBy: _fb, broadcast: _b, template: _tp, attachments: _a, widgets: _w, responses: _rs, ...rest } = card;
    return { card, input: { ...rest, [f]: text } };
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
    return lines.length ? `Widgets you can place in a card body with a line \`part = widget <name> {json values}\`:\n${lines.join('\n')}` : '';
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

  setSettings(input: Partial<Settings>): Settings {
    const next: Settings = { ...this.settings(), ...(typeof input.allowHtml === 'boolean' ? { allowHtml: input.allowHtml } : {}) };
    this.store.put('meta', 'settings', next);
    this.emit({ type: 'change', card: '' });
    return next;
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
  effectivePriority(card: Card, levels = this.priorities()): string {
    const answer = this.store.get<Answer>('answers', card.id);
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

  guidance(): Guidance {
    return this.store.get<Guidance>('meta', 'guidance') ?? { text: DEFAULT_GUIDANCE, version: 1, at: 0 };
  }

  /** An agent proposes new card guidance. The person approves it, and picks who receives it, on a system card. */
  proposeGuidance(text: string): Card {
    const clean = String(text ?? '').trim();
    if (!clean) throw new InboxError(400, 'text is required');
    const agents = this.store.list<Presence>('presence').map((p) => p.agent).filter((a) => a !== SYSTEM_AGENT);
    const id = `guidance-${randomId(4)}`;
    this.postCard({ token: '', role: 'owner' }, {
      id, agent: SYSTEM_AGENT, kind: 'system', deliver: 'none', priority: this.priorities()[0]?.id,
      title: 'Send new card guidance to agents?',
      text: `An agent proposes this guidance for writing cards. It goes out only if you approve it.\n\n${clean}`,
      options: [{ id: 'approve', label: 'Approve and send' }, { id: 'reject', label: 'Reject' }],
    });
    const card = { ...this.getCard(id), broadcast: { text: clean, agents } };
    this.store.put('cards', id, card);
    this.emit({ type: 'change', card: id });
    return card;
  }

  private resolveBroadcast(card: Card, answer: Answer): void {
    if (!card.broadcast) return;
    if ([answer.values['choice']].flat()[0] !== 'approve') { this.closeAs(card, 'resolved', 'Rejected: the guidance did not change.'); return; }
    const picked = Array.isArray(answer.values['agents']) ? (answer.values['agents'] as unknown[]).map(String) : card.broadcast.agents;
    const guidance: Guidance = { text: card.broadcast.text, version: this.guidance().version + 1, at: this.now() };
    this.store.put('meta', 'guidance', guidance);
    let sent = 0;
    for (const [k, subs] of this.agents) {
      const agent = k.slice(k.indexOf('\n') + 1);
      if (!picked.includes(agent)) continue;
      for (const send of subs) send({ type: 'guidance', id: randomId(6), guidance });
      sent++;
    }
    this.closeAs(card, 'resolved', `Sent guidance version ${guidance.version} to ${sent} connected agent${sent === 1 ? '' : 's'}. The others get it when they connect.`);
  }

  /** The cards a client may read, with their states: all of them for the owner. */
  listCards(caller: Caller): { card: Card; state: CardState }[] {
    return this.store.list<Card>('cards')
      .filter((c) => caller.role === 'owner' || c.token === caller.token)
      .map((c) => ({ card: publicCard(c), state: cardState(c, this.store.get<Answer>('answers', c.id)) }));
  }

  private owned(caller: Caller, id: string): Card {
    const card = this.getCard(id);
    if (caller.role !== 'owner' && card.token !== caller.token) throw new InboxError(403, 'another client owns this card');
    return card;
  }

  private closeAs(card: Card, kind: CloseKind, outcome: string): Card {
    const current = this.getCard(card.id);
    // A card closed while triage checks it needs no verdict any more.
    const triage = current.triage?.state === 'pending' ? { ...current.triage, state: 'skipped' as const, waiting: [], reason: 'The card closed before triage answered.' } : current.triage;
    const closed: Card = { ...current, triage, closed: { kind, outcome, at: this.now() } };
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

  /** The agent replies on its card. The card returns to the person's queue. */
  reply(caller: Caller, id: string, text: string): Card {
    const card = this.owned(caller, id);
    const clean = String(text || '').trim();
    if (!clean) throw new InboxError(400, 'text is required');
    if (clean.length > MAX_REPLY_BYTES) throw new InboxError(413, `a reply must be at most ${MAX_REPLY_BYTES} characters`);
    if (card.replies.length >= MAX_REPLIES) throw new InboxError(400, `a card takes at most ${MAX_REPLIES} replies`);
    const next: Card = { ...card, archivedAt: undefined, replies: [...card.replies, { text: clean, at: this.now(), seenAt: null }] };
    this.store.put('cards', id, next);
    this.emit({ type: 'change', card: id });
    return next;
  }

  /** The person opened the card, so its replies are seen. */
  seen(id: string): void {
    const card = this.getCard(id);
    const now = this.now();
    this.store.put('cards', id, { ...card, replies: card.replies.map((r) => ({ ...r, seenAt: r.seenAt ?? now })) });
    this.emit({ type: 'change', card: id });
  }

  /** A successor agent takes over a card, and with it any answer not yet delivered. */
  claim(caller: Caller, id: string, agent: string): Card {
    const card = this.getCard(id);
    if (caller.role !== 'owner' && card.token !== caller.token) throw new InboxError(403, 'another client owns this card');
    const next = { ...card, agent: String(agent), token: caller.role === 'owner' ? card.token : caller.token };
    this.store.put('cards', id, next);
    this.emit({ type: 'change', card: id });
    this.flush(next.agent);
    return next;
  }

  // ---- answers ----

  async answer(id: string, input: { values?: Record<string, unknown>; comment?: string; delivery?: Delivery; version?: number }): Promise<Answer> {
    const card = this.getCard(id);
    const delivery = input.delivery ?? 'default';
    if (!DELIVERIES.has(delivery)) throw new InboxError(400, 'unknown delivery');
    const values = input.values && typeof input.values === 'object' ? input.values : {};
    // The inbox accepts only a sealed value for a secret, so plain text never reaches storage.
    if (card.kind === 'secret' && (Object.keys(values).some((k) => k !== 'sealed') || ('sealed' in values && !isSealed(values['sealed'])))) {
      throw new InboxError(400, 'a secret card takes only a sealed value: seal it with the card\'s public key');
    }
    const before = this.store.get<Answer>('answers', id);
    const answer: Answer = {
      card: id,
      version: Number(input.version ?? card.version),
      values,
      comment: String(input.comment ?? '').trim(),
      delivery,
      savedAt: this.now(),
      deliveredAt: null,
      readAt: null,
      forcedAt: null,
      previous: before ? [...before.previous, { ...before, previous: undefined } as Omit<Answer, 'previous'>] : [],
    };
    const responses = (card.responses ?? []).map((r) => respond(r.template, values, r.values)).filter(Boolean);
    if (responses.length) answer.responses = responses;
    for (const p of answer.previous) delete (p as Partial<Answer>).previous;
    this.store.put('answers', id, answer);
    this.store.index(id, `${searchText(card)}\n${answer.comment}`);
    this.usage.record('answers');
    this.emit({ type: 'change', card: id });
    if (card.kind === 'system' && card.id.startsWith('pair-')) await this.resolvePairing(card, answer);
    else if (card.kind === 'system' && card.broadcast) this.resolveBroadcast(card, answer);
    else if (card.kind === 'system' && card.id.startsWith('priorities-')) this.resolvePriorityProposal(card, answer);
    else this.flush(card.agent);
    if (card.kind !== 'system' && card.kind !== 'secret') this.observeAnswer(card, this.store.get<Answer>('answers', id) ?? answer);
    return this.store.get<Answer>('answers', id) ?? answer;
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
    this.flush(this.getCard(id).agent);
    return this.store.get<Answer>('answers', id) ?? next;
  }

  /** Answers that wait for an agent that is offline. Agents query and claim them. */
  deadLetters(): { card: Card; answer: Answer }[] {
    return this.store.list<Answer>('answers')
      .filter((a) => !a.deliveredAt)
      .map((a) => ({ card: this.getCard(a.card), answer: a }))
      .filter(({ card }) => card.deliver === 'stream' && cardState(card, this.store.get('answers', card.id)) !== 'closed' && !this.isOnline(card.agent));
  }

  /** Cards that match the words, best first. `answered` keeps only cards the person answered. */
  search(query: string, limit = 20, answered = false): { card: Card; answer?: Answer }[] {
    const hits = this.store.search(String(query || ''), answered ? Math.max(limit * 5, 100) : limit);
    return hits
      .filter((h) => !answered || this.store.get('answers', h.card))
      .slice(0, limit)
      .map((h) => ({ card: this.store.get<Card>('cards', h.card), answer: this.store.get<Answer>('answers', h.card) }))
      .filter((r): r is { card: Card; answer: Answer | undefined } => !!r.card)
      .map(({ card, answer }) => (answer ? { card: publicCard(card), answer } : { card: publicCard(card) }));
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

  // ---- connections ----

  private key(token: string, agent: string): string {
    return `${token}\n${agent}`;
  }

  isOnline(agent: string): boolean {
    return this.store.get<Presence>('presence', agent)?.online ?? false;
  }

  /** An agent opens its stream. `instance` names the agent process, and stays the same across its reconnects.
   * Returns the function that closes it. */
  connect(caller: Caller, agent: string, send: AgentSend, instance?: string): () => void {
    if (String(agent).length > 80) throw new InboxError(400, 'agent must be at most 80 characters');
    const k = this.key(caller.token, agent);
    let set = this.agents.get(k);
    if (!set) this.agents.set(k, (set = new Set()));
    set.add(send);
    if (instance) this.instances.set(send, instance);
    this.usage.saw('agents', agent);
    if (instance) this.usage.saw('instances', instance);
    if (caller.token) this.usage.saw('tokens', caller.token);
    this.setPresence(agent, true);
    send({ type: 'hello', agent, version: 1, guidance: this.guidance().version });
    this.flush(agent);
    if (instance) this.resend(caller.token, agent, send, instance);
    return () => {
      const s = this.agents.get(k);
      if (!s?.delete(send)) return;
      if (s.size === 0) this.agents.delete(k);
      const stillOpen = [...this.agents.keys()].some((x) => x.endsWith(`\n${agent}`));
      if (!stillOpen) this.store.put<Presence>('presence', agent, { agent, online: true, lastSeen: this.now(), leftAt: this.now() });
    };
  }

  private setPresence(agent: string, online: boolean): void {
    this.store.put<Presence>('presence', agent, { agent, online, lastSeen: this.now() });
    this.emit({ type: 'presence', agent, online });
  }

  /** Send a new agent process each answer an earlier process received but never read, such as one a session got before it restarted. */
  private resend(token: string, agent: string, send: AgentSend, instance: string): void {
    for (const answer of this.store.list<Answer>('answers')) {
      if (!answer.deliveredAt || answer.readAt || answer.deliveredTo?.includes(instance)) continue;
      const card = this.store.get<Card>('cards', answer.card);
      if (!card || card.agent !== agent || (card.token ?? '') !== token || card.deliver !== 'stream') continue;
      if (cardState(card, answer) === 'closed') continue;
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
      if (!card || card.agent !== agent || card.deliver !== 'stream') continue;
      if (cardState(card, answer) === 'closed') continue;
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
        this.store.put<Presence>('presence', p.agent, { agent: p.agent, online: false, lastSeen: p.leftAt });
        this.emit({ type: 'presence', agent: p.agent, online: false });
      }
    }
    // Download counts from earlier days go.
    const today = `reads:${new Date(now).toISOString().slice(0, 10)}:`;
    for (const m of this.store.list<unknown>('meta')) {
      const key = (m as { key?: unknown })?.key;
      if (typeof key === 'string' && key.startsWith('reads:') && !key.startsWith(today)) this.store.delete('meta', key);
      const expiresAt = (m as { expiresAt?: unknown })?.expiresAt;
      if (typeof key === 'string' && key.startsWith('signin:') && typeof expiresAt === 'number' && expiresAt <= now) this.store.delete('meta', key);
    }
    this.pin.sweep();
    for (const m of this.store.list<{ key: string; at: number }>('messages')) {
      if (now - m.at > MESSAGE_MEMORY_MS) this.store.delete('messages', m.key);
    }
    for (const card of this.store.list<Card>('cards')) {
      const t = card.triage;
      if (t?.state === 'pending' && t.deadline && t.deadline <= now) {
        const late = (t.waiting ?? []).join(', ') || 'triage';
        const triage = t.policy === 'fail-closed'
          ? { ...t, state: 'held' as const, reason: `${late} did not answer in time, and its policy holds the card.`, waiting: [], at: now }
          : { ...t, state: 'passed' as const, reason: `${late} did not answer in time, so the card went through.`, waiting: [], at: now };
        this.store.put('cards', card.id, { ...card, triage });
        this.emit({ type: 'change', card: card.id });
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
  /** Clear the cards you dealt with: answered, retracted or closed, with no reply you have not seen. Search still finds them. */
  archive(caller: Caller): { archived: number } {
    if (caller.role !== 'owner') throw new InboxError(403, 'only the owner clears the inbox');
    const now = this.now();
    let archived = 0;
    for (const card of this.store.list<Card>('cards')) {
      if (card.archivedAt) continue;
      const answer = this.store.get<Answer>('answers', card.id);
      const s = cardState(card, answer);
      if (!['closed', 'answered', 'delivered', 'read'].includes(s)) continue;
      if (card.replies.some((r) => !r.seenAt && (!answer || r.at > answer.savedAt))) continue;
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
    for (const card of cards) {
      await Promise.all((card.attachments ?? []).filter((f) => f.id).map((f) => this.blobs.delete(f.id ?? '')));
      this.store.delete('answers', card.id);
      this.store.delete('cards', card.id);
      this.store.index(card.id, '');
    }
    this.emit({ type: 'change', card: '' });
    return { removed: cards.length };
  }

  state(): {
    cards: Card[]; answers: Record<string, Answer>; presence: Record<string, Presence>; states: Record<string, CardState>;
    priorities: Record<string, string>; levels: PriorityLevel[]; settings: Settings; guidance: Guidance;
  } {
    const cards = this.store.list<Card>('cards').filter((c) => !c.archivedAt).map(publicCard).sort((a, b) => a.createdAt - b.createdAt)
      // A body stored before the inbox checked bodies may not draw whole, so the page gets what it can draw.
      .map((c) => { const f = c.body !== undefined ? this.fallbackBody?.(c.body) : undefined; return f ? { ...c, bodyFallback: f } : c; });
    const shown = new Set(cards.map((c) => c.id));
    const answers = Object.fromEntries(this.store.list<Answer>('answers').filter((a) => shown.has(a.card)).map((a) => [a.card, a]));
    const presence = Object.fromEntries(this.store.list<Presence>('presence').map((p) => [p.agent, p]));
    const now = this.now();
    const states = Object.fromEntries(cards.map((c) => {
      const s = cardState(c, answers[c.id]);
      const p = presence[c.agent];
      // An open card whose agent left long ago is orphaned: another session can claim it.
      const orphaned = s === 'open' && c.deliver === 'stream' && p && !p.online && now - p.lastSeen > ORPHAN_MS;
      return [c.id, orphaned ? 'orphaned' : s];
    }));
    const levels = this.priorities();
    const priorities = Object.fromEntries(cards.map((c) => [c.id, this.effectivePriority(c, levels)]));
    return { cards, answers, presence, states, priorities, levels, settings: this.settings(), guidance: this.guidance() };
  }
}

const TYPES_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
};

const index = (i: number): number => i + 1;

/** The text search matches: the card's words, its tags, and its file names. */
function searchText(card: Card): string {
  return [card.title, card.text, card.recommendation, card.body, card.status, ...Object.entries(card.tags ?? {}).map(([k, v]) => `${k} ${v}`), ...(card.attachments ?? []).map((a) => a.name)]
    .filter(Boolean).join('\n');
}

const ORIGIN_FIELDS = ['harness', 'session', 'name', 'host', 'cwd', 'herdrPane', 'herdrWorkspace', 'herdrTab'] as const;

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
  return { type: (m[1] ?? '').toLowerCase(), bytes: Uint8Array.from(raw, (c) => c.charCodeAt(0)) };
}

function typeFromName(name: string): string {
  return TYPES_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** A card without the id of the token that posted it. */
export function publicCard(card: Card): Card {
  const { token: _token, ...rest } = card;
  return rest;
}
