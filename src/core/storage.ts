// The storage adapter. Calls are synchronous, like node:sqlite and the SQL API
// of a Durable Object, so each inbox change runs to completion before the next
// one starts and needs no lock.

export type Collection = 'cards' | 'answers' | 'tokens' | 'pairings' | 'presence' | 'meta' | 'templates' | 'widgets' | 'messages';

export interface SearchHit {
  card: string;
  rank: number;
}

export interface Storage {
  get<T>(collection: Collection, id: string): T | undefined;
  put<T>(collection: Collection, id: string, value: T): void;
  delete(collection: Collection, id: string): void;
  list<T>(collection: Collection): T[];
  /** Replace the searchable text of a card. Empty text removes the card from search. */
  index(card: string, text: string): void;
  search(query: string, limit: number): SearchHit[];
  close(): void;
}

/** Storage kept in memory. For tests and for a page that hosts an inbox. */
export class MemoryStorage implements Storage {
  private data = new Map<string, Map<string, string>>();
  private text = new Map<string, string>();

  private bucket(c: Collection): Map<string, string> {
    let b = this.data.get(c);
    if (!b) this.data.set(c, (b = new Map()));
    return b;
  }

  get<T>(c: Collection, id: string): T | undefined {
    const v = this.bucket(c).get(id);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }

  put<T>(c: Collection, id: string, value: T): void {
    this.bucket(c).set(id, JSON.stringify(value));
  }

  delete(c: Collection, id: string): void {
    this.bucket(c).delete(id);
  }

  list<T>(c: Collection): T[] {
    return [...this.bucket(c).values()].map((v) => JSON.parse(v) as T);
  }

  index(card: string, text: string): void {
    if (text) this.text.set(card, text.toLowerCase());
    else this.text.delete(card);
  }

  search(query: string, limit: number): SearchHit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: SearchHit[] = [];
    for (const [card, text] of this.text) {
      if (words.length && words.every((w) => text.includes(w))) hits.push({ card, rank: 0 });
    }
    return hits.slice(0, limit);
  }

  close(): void {}
}

/** Where file bytes go: R2 in the Cloudflare build, files on disk on a laptop.
 * Calls are asynchronous, so the inbox stores the bytes before it commits the card. */
export interface BlobStore {
  put(key: string, bytes: Uint8Array<ArrayBuffer>, type: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | undefined>;
  delete(key: string): Promise<void>;
}

export class MemoryBlobs implements BlobStore {
  private readonly data = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>();
  async put(key: string, bytes: Uint8Array<ArrayBuffer>, type: string): Promise<void> { this.data.set(key, { bytes, type }); }
  async get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | undefined> { return this.data.get(key); }
  async delete(key: string): Promise<void> { this.data.delete(key); }
}
