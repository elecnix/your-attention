// The Durable Object's storage adapter on node:sqlite: search entries stay correct and counted, and an entry is
// found by its row id, so replacing or removing one costs the same however many cards the inbox has.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { DurableSqlStorage } from '../../src/cloudflare/storage.ts';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  const plans: string[] = [];
  const sql = { exec: (q: string, ...b: unknown[]) => {
    if (/^\s*(DELETE|SELECT)\b.*\bsearch\b/i.test(q) && !/MATCH/i.test(q)) {
      plans.push(...(db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...(b as never[])) as { detail: string }[]).map((r) => r.detail));
    }
    const stmt = db.prepare(q);
    const rows = /^\s*(select|with)/i.test(q) ? stmt.all(...(b as never[])) as Record<string, unknown>[] : (stmt.run(...(b as never[])), []);
    return { toArray: () => rows };
  } };
  return { db, sql, plans };
}

describe('the Durable Object search index', () => {
  it('replaces and removes a card\'s entry, and keeps the byte count right', () => {
    const { sql } = sqlite();
    const store = new DurableSqlStorage(sql);
    const empty = store.bytes();
    store.index('c1', 'walrus tusks');
    store.index('c2', 'narwhal horn');
    store.index('c1', 'walrus whiskers');
    assert.deepEqual(store.search('walrus', 10).map((h) => h.card), ['c1']);
    assert.deepEqual(store.search('tusks', 10), []);
    assert.equal(store.bytes(), empty + 'walrus whiskers'.length + 'narwhal horn'.length);
    store.index('c1', '');
    assert.deepEqual(store.search('walrus', 10), []);
    assert.equal(store.bytes(), empty + 'narwhal horn'.length);
    assert.equal(new DurableSqlStorage(sql).bytes(), store.bytes(), 'a fresh count agrees');
  });

  it('finds an entry by its row id, never by scanning every entry', () => {
    const { sql, plans } = sqlite();
    const store = new DurableSqlStorage(sql);
    // The first count reads every entry once, by design.
    store.bytes();
    plans.length = 0;
    store.index('c1', 'walrus');
    store.index('c1', 'narwhal');
    store.index('c1', '');
    assert.ok(plans.length > 0);
    // FTS5 plans a lookup by row id as `INDEX 0:=`, and a scan of every entry as `INDEX 0:`.
    assert.deepEqual(plans.filter((p) => /^SCAN search VIRTUAL TABLE INDEX 0:$/.test(p)), []);
  });

  it('keeps the entries an inbox indexed before it mapped cards to row ids', () => {
    const { db, sql } = sqlite();
    db.exec('CREATE VIRTUAL TABLE search USING fts5(card UNINDEXED, text)');
    db.prepare('INSERT INTO search (card, text) VALUES (?, ?)').run('old', 'walrus');
    const store = new DurableSqlStorage(sql);
    assert.deepEqual(store.search('walrus', 10).map((h) => h.card), ['old']);
    store.index('old', 'narwhal');
    assert.deepEqual(store.search('walrus', 10), []);
    assert.deepEqual(store.search('narwhal', 10).map((h) => h.card), ['old']);
  });

  it('reads the first rows of a collection in write order without sorting the whole collection', () => {
    const { db, sql } = sqlite();
    const store = new DurableSqlStorage(sql);
    for (const id of ['b', 'a', 'c']) store.put('cleared', id, { id });
    store.put('cleared', 'b', { id: 'b', again: true });
    assert.deepEqual(store.first<{ id: string }>('cleared', 2).map((r) => r.id), ['b', 'a']);
    const plan = (db.prepare('EXPLAIN QUERY PLAN SELECT value FROM docs WHERE collection = ? ORDER BY rowid LIMIT ?').all('cleared', 2) as { detail: string }[]).map((r) => r.detail);
    assert.deepEqual(plan.filter((p) => /TEMP B-TREE/.test(p)), []);
  });
});
