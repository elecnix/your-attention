// The storage adapter. Calls are synchronous, like node:sqlite and the SQL API
// of a Durable Object, so each inbox change runs to completion before the next
// one starts and needs no lock.

export type Collection = 'cards' | 'answers' | 'tokens' | 'pairings' | 'presence' | 'meta';

export interface SearchHit {
  card: string;
  rank: number;
}

export interface Storage {
  get<T>(collection: Collection, id: string): T | undefined;
  put<T>(collection: Collection, id: string, value: T): void;
  delete(collection: Collection, id: string): void;
  list<T>(collection: Collection): T[];
  /** Replace the searchable text of a card. */
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
    this.text.set(card, text.toLowerCase());
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
