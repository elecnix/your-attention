// What GET /v1/state sends for each card: enough for the queue, the priority levels, presence and the answer states. The
// page and the terminal client fetch the whole card from GET /v1/cards/<id> when it opens. The inbox writes a card's
// summary each time the card or its answer changes, into its own collection, so the state reads only small rows, and
// only those of the cards it shows. A hosted request gets 10 ms of CPU time, too little to read every whole card.
import { randomId } from './crypto.ts';
import type { Collection, SearchHit, Storage } from './storage.ts';
import type { Answer, Card } from './types.ts';

/** The most cards the hosted inbox's state shows, so its request fits 10 ms of CPU time. wrangler.jsonc sets it in SHOWN_CARDS_LIMIT. */
export const HOSTED_SHOWN_CARDS = 500;
/** How much of the text a link to a card previews on hover. */
const PREVIEW_CHARS = 300;
const MAX_LINKS = 20;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 100;

/** A tag key or value as the inbox keeps it: one line, trimmed, and at most MAX_TAG_CHARS. A line break an agent wrote
 * into a value would forge a line in another agent's card_guidance, which prints the tags in use, so each run of
 * spaces, tabs and breaks becomes one space. */
export function tagText(text: string): string {
  // `\s` covers the line breaks a renderer honours except NEL, which JSON.stringify emits raw, so it goes too.
  return text.replace(/[\s\u0085\u2028\u2029]+/g, ' ').trim().slice(0, MAX_TAG_CHARS);
}

/** A card's tags as the inbox stores them, at most MAX_TAGS, with an empty key dropped. */
export function cleanTags(tags: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!tags) return undefined;
  const entries = Object.entries(tags).map(([k, v]): [string, string] => [tagText(String(k)), tagText(String(v))]).filter(([k]) => k).slice(0, MAX_TAGS);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

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

/** A cleared card, by when the person cleared it, so the purge finds the cards it deletes without reading every card.
 * The inbox writes the row when the person clears the card, so the rows come in the order the cards were cleared. */
export interface ClearedCard {
  id: string;
  archivedAt: number;
}

export function summarize(card: Card, answer: Answer | undefined): CardSummary {
  const text = card.text ?? '';
  const links = [...new Set([...text.matchAll(/\[\[([\w.:-]{1,80})\]\]/g)].map((m) => m[1] as string))].slice(0, MAX_LINKS);
  const tags = cleanTags(card.tags);
  const replyAt = card.replies.length ? Math.max(...card.replies.map((r) => r.at)) : undefined;
  const origin = card.origin?.name || card.origin?.harness ? { ...(card.origin.name ? { name: card.origin.name } : {}), ...(card.origin.harness ? { harness: card.origin.harness } : {}) } : undefined;
  return {
    id: card.id, agent: card.agent, kind: card.kind, title: card.title, priority: card.priority, status: card.status, rating: card.rating, tags, origin,
    from: card.from, follows: card.follows, followedBy: card.followedBy, deliver: card.deliver, version: card.version,
    createdAt: card.createdAt, updatedAt: card.updatedAt, expiresAt: card.expiresAt,
    // The whole outcome comes with the card. Triage or the page can write a long one. A dismissal's draft stays in the card:
    // only the owner reads it, and a summary is a small row.
    closed: card.closed ? { kind: card.closed.kind, outcome: card.closed.outcome.slice(0, PREVIEW_CHARS), at: card.closed.at } : undefined,
    triage: card.triage ? { state: card.triage.state } : undefined,
    replyAt, unseenReplies: card.replies.some((r) => !r.seenAt) || undefined,
    links: links.length ? links : undefined, preview: text ? text.slice(0, PREVIEW_CHARS) : undefined,
    answer: answer ? { version: answer.version, savedAt: answer.savedAt, deliveredAt: answer.deliveredAt, readAt: answer.readAt, forcedAt: answer.forcedAt } : undefined,
    rev: randomId(6),
  };
}

/** Storage that keeps a summary of each card the state shows, beside the card: every write to a card or an answer rewrites
 * the summary, and a card cleared from the state has a `cleared` row instead. The inbox writes through it, so no code
 * path forgets one. */
export class SummarizedStorage implements Storage {
  private readonly inner: Storage;

  /** The bytes the inner storage keeps, when it measures them. */
  readonly bytes?: () => number;

  constructor(inner: Storage) {
    this.inner = inner;
    if (inner.bytes) this.bytes = () => inner.bytes?.() ?? 0;
    // An inbox from before summaries, or before the cleared rows, writes them once.
    if ((inner.get<{ version?: number }>('meta', 'summaries')?.version ?? 0) < 2) {
      // Oldest cleared first, so the cleared rows come in the order the cards were cleared.
      for (const c of inner.list<Card>('cards').sort((a, b) => (a.archivedAt ?? 0) - (b.archivedAt ?? 0))) this.sync(c.id, c);
      inner.put('meta', 'summaries', { key: 'summaries', version: 2 });
    }
  }

  /** A change to a card rewrites its summary, or its cleared row once the person cleared it. */
  private sync(id: string, card: Card | undefined): void {
    if (card && !card.archivedAt) {
      this.inner.put('summaries', id, summarize(card, this.inner.get<Answer>('answers', id)));
      this.inner.delete('cleared', id);
      return;
    }
    this.inner.delete('summaries', id);
    if (card?.archivedAt) this.inner.put<ClearedCard>('cleared', id, { id, archivedAt: card.archivedAt });
    else this.inner.delete('cleared', id);
  }

  /** A change to an answer rewrites the summary of its card when the card is on show. Other cards have no summary. */
  private syncAnswer(id: string): void {
    const card = this.inner.get<Card>('cards', id);
    if (card && !card.archivedAt) this.inner.put('summaries', id, summarize(card, this.inner.get<Answer>('answers', id)));
  }

  get<T>(collection: Collection, id: string): T | undefined { return this.inner.get<T>(collection, id); }
  put<T>(collection: Collection, id: string, value: T): void {
    this.inner.put(collection, id, value);
    if (collection === 'cards') this.sync(id, value as Card);
    else if (collection === 'answers') this.syncAnswer(id);
  }
  delete(collection: Collection, id: string): void {
    this.inner.delete(collection, id);
    if (collection === 'cards') this.sync(id, undefined);
    else if (collection === 'answers') this.syncAnswer(id);
  }
  list<T>(collection: Collection): T[] { return this.inner.list<T>(collection); }
  first<T>(collection: Collection, limit: number): T[] { return this.inner.first<T>(collection, limit); }
  count(collection: Collection): number { return this.inner.count?.(collection) ?? this.inner.list(collection).length; }
  index(card: string, text: string): void { this.inner.index(card, text); }
  search(query: string, limit: number): SearchHit[] { return this.inner.search(query, limit); }
  close(): void { this.inner.close(); }
}
