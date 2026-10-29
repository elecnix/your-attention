// What GET /v1/state sends for each card: enough for the queue, the priority levels, presence and the answer states. The
// page and the terminal client fetch the whole card from GET /v1/cards/<id> when it opens. The inbox writes a card's
// summary each time the card or its answer changes, into its own collection, so the state reads only small rows, and
// only those of the cards it shows. A hosted request gets 10 ms of CPU time, too little to read every whole card.
import { randomId } from './crypto.ts';
import type { Collection, SearchHit, Storage } from './storage.ts';
import type { Answer, Card } from './types.ts';

/** The most cards the state shows. A new card past it waits until the person clears answered or closed cards. */
export const MAX_SHOWN_CARDS = 500;
/** How much of the text a link to a card previews on hover. */
const PREVIEW_CHARS = 300;
const MAX_LINKS = 20;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 100;

export interface AnswerSummary {
  version: number;
  savedAt: number;
  deliveredAt: number | null;
  readAt: number | null;
  forcedAt: number | null;
}

export interface CardSummary {
  id: string;
  agent: string;
  kind: Card['kind'];
  title: string;
  priority: string;
  status?: string;
  rating?: number;
  tags?: Record<string, string>;
  /** The session name, for the agent's name in the list, and the harness, which priority rules read. */
  origin?: { name?: string; harness?: string };
  from?: string;
  follows?: string;
  followedBy?: string;
  deliver: Card['deliver'];
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  closed?: Card['closed'];
  triage?: { state: NonNullable<Card['triage']>['state'] };
  /** The time of the newest agent reply, and whether any reply waits to be seen. */
  replyAt?: number;
  unseenReplies?: boolean;
  /** The cards its text links to with [[card-id]], for the cards that link to the one on screen. */
  links?: string[];
  /** The start of its text, for a link's hover preview. */
  preview?: string;
  answer?: AnswerSummary;
  /** Changes with every change to the card or its answer, so a client knows its copy of the whole card is current. */
  rev: string;
}

export function summarize(card: Card, answer: Answer | undefined): CardSummary {
  const text = card.text ?? '';
  const links = [...new Set([...text.matchAll(/\[\[([\w.:-]{1,80})\]\]/g)].map((m) => m[1] as string))].slice(0, MAX_LINKS);
  const tags = card.tags ? Object.fromEntries(Object.entries(card.tags).slice(0, MAX_TAGS).map(([k, v]) => [String(k).slice(0, MAX_TAG_CHARS), String(v).slice(0, MAX_TAG_CHARS)])) : undefined;
  const replyAt = card.replies.length ? Math.max(...card.replies.map((r) => r.at)) : undefined;
  const origin = card.origin?.name || card.origin?.harness ? { ...(card.origin.name ? { name: card.origin.name } : {}), ...(card.origin.harness ? { harness: card.origin.harness } : {}) } : undefined;
  return {
    id: card.id, agent: card.agent, kind: card.kind, title: card.title, priority: card.priority, status: card.status, rating: card.rating, tags, origin,
    from: card.from, follows: card.follows, followedBy: card.followedBy, deliver: card.deliver, version: card.version,
    createdAt: card.createdAt, updatedAt: card.updatedAt, expiresAt: card.expiresAt,
    // The whole outcome comes with the card. Triage or the page can write a long one.
    closed: card.closed ? { ...card.closed, outcome: card.closed.outcome.slice(0, PREVIEW_CHARS) } : undefined,
    triage: card.triage ? { state: card.triage.state } : undefined,
    replyAt, unseenReplies: card.replies.some((r) => !r.seenAt) || undefined,
    links: links.length ? links : undefined, preview: text ? text.slice(0, PREVIEW_CHARS) : undefined,
    answer: answer ? { version: answer.version, savedAt: answer.savedAt, deliveredAt: answer.deliveredAt, readAt: answer.readAt, forcedAt: answer.forcedAt } : undefined,
    rev: randomId(6),
  };
}

/** Storage that keeps a summary of each card the state shows, beside the card: every write to a card or an answer rewrites
 * the summary, and a card cleared from the state has none. The inbox writes through it, so no code path forgets one. */
export class SummarizedStorage implements Storage {
  private readonly inner: Storage;

  /** The bytes the inner storage keeps, when it measures them. */
  readonly bytes?: () => number;

  constructor(inner: Storage) {
    this.inner = inner;
    if (inner.bytes) this.bytes = () => inner.bytes?.() ?? 0;
    // An inbox from before summaries writes them once.
    if (!inner.get('meta', 'summaries')) {
      for (const c of inner.list<Card>('cards')) this.sync(c.id, c);
      inner.put('meta', 'summaries', { key: 'summaries', version: 1 });
    }
  }

  private sync(id: string, card = this.inner.get<Card>('cards', id)): void {
    if (!card || card.archivedAt) this.inner.delete('summaries', id);
    else this.inner.put('summaries', id, summarize(card, this.inner.get<Answer>('answers', id)));
  }

  get<T>(collection: Collection, id: string): T | undefined { return this.inner.get<T>(collection, id); }
  put<T>(collection: Collection, id: string, value: T): void {
    this.inner.put(collection, id, value);
    if (collection === 'cards') this.sync(id, value as Card);
    else if (collection === 'answers') this.sync(id);
  }
  delete(collection: Collection, id: string): void {
    this.inner.delete(collection, id);
    if (collection === 'cards' || collection === 'answers') this.sync(id);
  }
  list<T>(collection: Collection): T[] { return this.inner.list<T>(collection); }
  count(collection: Collection): number { return this.inner.count?.(collection) ?? this.inner.list(collection).length; }
  index(card: string, text: string): void { this.inner.index(card, text); }
  search(query: string, limit: number): SearchHit[] { return this.inner.search(query, limit); }
  close(): void { this.inner.close(); }
}
