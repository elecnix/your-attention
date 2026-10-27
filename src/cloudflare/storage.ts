// Storage for the Cloudflare build: the SQLite database of a Durable Object, and R2 for file bytes.
import type { BlobStore, Collection, SearchHit, Storage } from '../core/storage.ts';

/** The part of a Durable Object's SqlStorage this adapter uses. Its calls are synchronous. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export class DurableSqlStorage implements Storage {
  private readonly sql: SqlLike;
  private readonly fts: boolean;

  constructor(sql: SqlLike) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, id))');
    let fts = true;
    try {
      sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(card UNINDEXED, text)');
    } catch {
      // Without FTS5, search falls back to a table matched with LIKE.
      fts = false;
      sql.exec('CREATE TABLE IF NOT EXISTS search (card TEXT PRIMARY KEY, text TEXT NOT NULL)');
    }
    this.fts = fts;
  }

  get<T>(collection: Collection, id: string): T | undefined {
    const row = this.sql.exec('SELECT value FROM docs WHERE collection = ? AND id = ?', collection, id).toArray()[0];
    return row ? (JSON.parse(String(row['value'])) as T) : undefined;
  }

  put<T>(collection: Collection, id: string, value: T): void {
    this.sql.exec('INSERT INTO docs (collection, id, value) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET value = excluded.value', collection, id, JSON.stringify(value));
  }

  delete(collection: Collection, id: string): void {
    this.sql.exec('DELETE FROM docs WHERE collection = ? AND id = ?', collection, id);
  }

  list<T>(collection: Collection): T[] {
    return this.sql.exec('SELECT value FROM docs WHERE collection = ? ORDER BY rowid', collection).toArray().map((r) => JSON.parse(String(r['value'])) as T);
  }

  index(card: string, text: string): void {
    this.sql.exec('DELETE FROM search WHERE card = ?', card);
    this.sql.exec('INSERT INTO search (card, text) VALUES (?, ?)', card, text);
  }

  search(query: string, limit: number): SearchHit[] {
    const words = query.split(/\s+/).map((w) => w.replace(/["%_]/g, '')).filter(Boolean);
    if (!words.length) return [];
    if (this.fts) {
      return this.sql.exec('SELECT card, rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?', words.map((w) => `"${w}"*`).join(' '), limit)
        .toArray().map((r) => ({ card: String(r['card']), rank: Number(r['rank']) }));
    }
    const where = words.map(() => 'text LIKE ?').join(' AND ');
    return this.sql.exec(`SELECT card FROM search WHERE ${where} LIMIT ?`, ...words.map((w) => `%${w}%`), limit)
      .toArray().map((r) => ({ card: String(r['card']), rank: 0 }));
  }

  close(): void {}
}

/** The part of an R2 bucket this adapter uses. */
export interface BucketLike {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

/** File bytes in R2, under one prefix per inbox. */
export class R2Blobs implements BlobStore {
  private readonly bucket: BucketLike;
  private readonly prefix: string;

  constructor(bucket: BucketLike, prefix: string) {
    this.bucket = bucket;
    this.prefix = prefix;
  }

  async put(key: string, bytes: Uint8Array<ArrayBuffer>, type: string): Promise<void> {
    await this.bucket.put(`${this.prefix}/${key}`, bytes, { httpMetadata: { contentType: type } });
  }

  async get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | undefined> {
    const obj = await this.bucket.get(`${this.prefix}/${key}`);
    if (!obj) return undefined;
    return { bytes: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType ?? 'application/octet-stream' };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(`${this.prefix}/${key}`);
  }
}
