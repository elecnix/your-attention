// Storage in one SQLite file, with full-text search over cards and answers.
import { DatabaseSync } from 'node:sqlite';
import type { Collection, SearchHit, Storage } from '../core/storage.ts';

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS docs (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(card UNINDEXED, text);
    `);
  }

  get<T>(collection: Collection, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM docs WHERE collection = ? AND id = ?').get(collection, id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  put<T>(collection: Collection, id: string, value: T): void {
    this.db.prepare('INSERT INTO docs (collection, id, value) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET value = excluded.value')
      .run(collection, id, JSON.stringify(value));
  }

  delete(collection: Collection, id: string): void {
    this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id);
  }

  list<T>(collection: Collection): T[] {
    const rows = this.db.prepare('SELECT value FROM docs WHERE collection = ? ORDER BY rowid').all(collection) as { value: string }[];
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  index(card: string, text: string): void {
    this.db.prepare('DELETE FROM search WHERE card = ?').run(card);
    this.db.prepare('INSERT INTO search (card, text) VALUES (?, ?)').run(card, text);
  }

  search(query: string, limit: number): SearchHit[] {
    // Each word becomes a quoted prefix term, so user input never reaches FTS5 syntax.
    const terms = query.split(/\s+/).map((w) => w.replace(/"/g, '')).filter(Boolean).map((w) => `"${w}"*`);
    if (!terms.length) return [];
    const rows = this.db.prepare('SELECT card, rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?').all(terms.join(' '), limit) as { card: string; rank: number }[];
    return rows.map((r) => ({ card: r.card, rank: r.rank }));
  }

  close(): void {
    this.db.close();
  }
}
