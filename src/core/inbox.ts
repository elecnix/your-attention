// The inbox: every change to cards, answers, presence and tokens goes through
// this one object. Storage calls are synchronous, so each change completes
// before the next starts. Every change is written to storage before a method
// returns, and memory holds only the open connections.
import { newSecret, pairingCode, randomId, sha256 } from './crypto.ts';
import type { Storage } from './storage.ts';
import type {
  AgentEvent, Answer, Card, CardState, CloseKind, Delivery, NewCard, PageEvent, Pairing, Presence, Role, Token,
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

export const SYSTEM_AGENT = 'system';
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 5;
const PRIORITIES = new Set(['now', 'soon', 'later']);
const CLOSE_KINDS = new Set<CloseKind>(['retracted', 'self-answered', 'answered-in-terminal', 'resolved']);
const DELIVERIES = new Set<Delivery>(['default', 'steer', 'followUp', 'force']);

/** A card's state follows from its closure and its answer. */
export function cardState(card: Card, answer: Answer | undefined): CardState {
  // An answer saved after the agent closed the card still goes to the agent.
  if (card.closed && !(answer && answer.savedAt > card.closed.at)) return 'closed';
  if (!answer) return 'open';
  if (answer.readAt) return 'read';
  if (answer.deliveredAt) return 'delivered';
  return 'answered';
}

type AgentSend = (ev: AgentEvent) => void;
type PageSend = (ev: PageEvent) => void;

export class Inbox {
  private readonly store: Storage;
  private readonly now: () => number;
  private readonly agents = new Map<string, Set<AgentSend>>();
  private readonly pages = new Set<PageSend>();

  constructor(store: Storage, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
    // Connections do not survive a restart, so nobody is online at start.
    for (const p of store.list<Presence>('presence')) {
      if (p.online) store.put('presence', p.agent, { ...p, online: false });
    }
  }

  // ---- tokens and pairing ----

  /** Create a token and return its secret. The secret is shown once. */
  async createToken(name: string, role: Role): Promise<{ token: Token; secret: string }> {
    const id = randomId(6);
    const secret = newSecret(id);
    const token: Token = { id, hash: await sha256(secret), name, role, createdAt: this.now() };
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
  }

  /** A client asks to pair. The person sees a system card with the code. */
  requestPairing(name: string, role: Role): Pairing {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new InboxError(400, 'name is required');
    if (role !== 'agent' && role !== 'owner') throw new InboxError(400, 'role must be agent or owner');
    const pending = this.store.list<Pairing>('pairings').filter((p) => p.status === 'pending');
    if (pending.length >= MAX_PENDING_PAIRINGS) throw new InboxError(429, 'too many pairing requests are waiting');
    const pairing: Pairing = { id: randomId(8), name: clean, role, code: pairingCode(), status: 'pending', createdAt: this.now() };
    this.store.put('pairings', pairing.id, pairing);
    this.postCard({ token: '', role: 'owner' }, {
      id: `pair-${pairing.id}`,
      agent: SYSTEM_AGENT,
      kind: 'system',
      title: `Pair ${role === 'owner' ? 'a front-end' : 'an agent client'}: ${clean}`,
      text: `A client asks for ${role === 'owner' ? 'full access, as a front-end' : 'agent access'}. It shows the code ${pairing.code}. Approve only if the client shows the same code.`,
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
      const { secret } = await this.createToken(p.name, p.role);
      this.store.put<Pairing>('pairings', id, { ...p, status: 'approved', secret });
      this.closeAs(card, 'resolved', `Paired ${p.name}.`);
    } else {
      this.store.put<Pairing>('pairings', id, { ...p, status: 'denied' });
      this.closeAs(card, 'resolved', `Denied ${p.name}.`);
    }
  }

  // ---- cards ----

  postCard(caller: Caller, input: NewCard): Card {
    if (!input || typeof input !== 'object') throw new InboxError(400, 'card must be an object');
    const title = String(input.title ?? '').trim();
    if (!title) throw new InboxError(400, 'title is required');
    const agent = String(input.agent ?? '').trim();
    if (!agent) throw new InboxError(400, 'agent is required');
    if (agent === SYSTEM_AGENT && caller.token !== '') throw new InboxError(403, 'the system agent is reserved');
    const priority = input.priority ?? 'soon';
    if (!PRIORITIES.has(priority)) throw new InboxError(400, 'priority must be now, soon or later');
    const id = input.id ? String(input.id) : randomId(8);
    if (!/^[\w.:-]{1,80}$/.test(id)) throw new InboxError(400, 'id must be 1 to 80 letters, digits, dots, colons, dashes or underscores');

    const now = this.now();
    const before = this.store.get<Card>('cards', id);
    if (before && before.token !== caller.token && caller.role !== 'owner') throw new InboxError(403, 'another client owns this card');
    const card: Card = {
      id,
      agent,
      token: before?.token ?? caller.token,
      kind: input.kind ?? 'ask',
      title,
      text: input.text,
      recommendation: input.recommendation,
      body: input.body,
      options: input.options,
      multiple: input.multiple,
      questions: input.questions,
      screen: input.screen,
      priority,
      origin: input.origin,
      tags: input.tags,
      follows: input.follows ?? before?.follows,
      followedBy: before?.followedBy,
      deliver: input.deliver ?? 'stream',
      version: (before?.version ?? 0) + 1,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
      closed: before?.closed,
      replies: before?.replies ?? [],
    };
    this.store.put('cards', id, card);
    this.store.index(id, [card.title, card.text, card.recommendation, card.body].filter(Boolean).join('\n'));
    if (card.follows && card.follows !== id) {
      const prev = this.store.get<Card>('cards', card.follows);
      if (prev) {
        this.store.put('cards', prev.id, { ...prev, followedBy: id });
        this.emit({ type: 'change', card: prev.id });
      }
    }
    this.emit({ type: 'change', card: id });
    return card;
  }

  getCard(id: string): Card {
    const card = this.store.get<Card>('cards', id);
    if (!card) throw new InboxError(404, 'unknown card');
    return card;
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
    const closed: Card = { ...this.getCard(card.id), closed: { kind, outcome, at: this.now() } };
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
    const next = { ...card, replies: [...card.replies, { text: clean, at: this.now(), seenAt: null }] };
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
    const before = this.store.get<Answer>('answers', id);
    const answer: Answer = {
      card: id,
      version: Number(input.version ?? card.version),
      values: input.values && typeof input.values === 'object' ? input.values : {},
      comment: String(input.comment ?? '').trim(),
      delivery,
      savedAt: this.now(),
      deliveredAt: null,
      readAt: null,
      forcedAt: null,
      previous: before ? [...before.previous, { ...before, previous: undefined } as Omit<Answer, 'previous'>] : [],
    };
    for (const p of answer.previous) delete (p as Partial<Answer>).previous;
    this.store.put('answers', id, answer);
    this.store.index(id, [card.title, card.text, card.recommendation, card.body, answer.comment].filter(Boolean).join('\n'));
    this.emit({ type: 'change', card: id });
    if (card.kind === 'system' && card.id.startsWith('pair-')) await this.resolvePairing(card, answer);
    else this.flush(card.agent);
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

  search(query: string, limit = 20): { card: Card; answer?: Answer }[] {
    return this.store.search(String(query || ''), limit)
      .map((h) => ({ card: this.store.get<Card>('cards', h.card), answer: this.store.get<Answer>('answers', h.card) }))
      .filter((r): r is { card: Card; answer: Answer | undefined } => !!r.card)
      .map(({ card, answer }) => (answer ? { card: publicCard(card), answer } : { card: publicCard(card) }));
  }

  // ---- connections ----

  private key(token: string, agent: string): string {
    return `${token}\n${agent}`;
  }

  isOnline(agent: string): boolean {
    return this.store.get<Presence>('presence', agent)?.online ?? false;
  }

  /** An agent opens its stream. Returns the function that closes it. */
  connect(caller: Caller, agent: string, send: AgentSend): () => void {
    const k = this.key(caller.token, agent);
    let set = this.agents.get(k);
    if (!set) this.agents.set(k, (set = new Set()));
    set.add(send);
    this.setPresence(agent, true);
    send({ type: 'hello', agent, version: 1 });
    this.flush(agent);
    return () => {
      const s = this.agents.get(k);
      if (!s?.delete(send)) return;
      if (s.size === 0) this.agents.delete(k);
      const stillOpen = [...this.agents.keys()].some((x) => x.endsWith(`\n${agent}`));
      if (!stillOpen) this.setPresence(agent, false);
    };
  }

  private setPresence(agent: string, online: boolean): void {
    this.store.put<Presence>('presence', agent, { agent, online, lastSeen: this.now() });
    this.emit({ type: 'presence', agent, online });
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
      const next = { ...answer, deliveredAt: this.now() };
      this.store.put('answers', answer.card, next);
      const ev: AgentEvent = { type: 'answer', id: randomId(6), card: publicCard(card), answer: next };
      for (const send of subs) send(ev);
      this.emit({ type: 'change', card: card.id });
    }
  }

  subscribePage(send: PageSend): () => void {
    this.pages.add(send);
    return () => { this.pages.delete(send); };
  }

  /** The page code changed: open pages reload and keep their drafts. */
  announceCode(): void {
    this.emit({ type: 'code' });
  }

  private emit(ev: PageEvent): void {
    for (const send of this.pages) send(ev);
  }

  /** Called by the platform alarm: expires old pairing requests. */
  sweep(): void {
    const now = this.now();
    for (const p of this.store.list<Pairing>('pairings')) {
      if (p.status !== 'pending' || now - p.createdAt < PAIRING_TTL_MS) continue;
      this.store.put<Pairing>('pairings', p.id, { ...p, status: 'denied' });
      const card = this.store.get<Card>('cards', `pair-${p.id}`);
      if (card && !card.closed) this.closeAs(card, 'resolved', 'The pairing request expired.');
    }
  }

  /** Everything a page needs to draw the inbox. */
  state(): { cards: Card[]; answers: Record<string, Answer>; presence: Record<string, Presence>; states: Record<string, CardState> } {
    const cards = this.store.list<Card>('cards').map(publicCard).sort((a, b) => a.createdAt - b.createdAt);
    const answers = Object.fromEntries(this.store.list<Answer>('answers').map((a) => [a.card, a]));
    const presence = Object.fromEntries(this.store.list<Presence>('presence').map((p) => [p.agent, p]));
    const states = Object.fromEntries(cards.map((c) => [c.id, cardState(c, answers[c.id])]));
    return { cards, answers, presence, states };
  }
}

/** A card without the id of the token that posted it. */
export function publicCard(card: Card): Card {
  const { token: _token, ...rest } = card;
  return rest;
}
