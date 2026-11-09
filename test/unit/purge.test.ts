// The purge: cleared cards and unanswered cards go 30 days after their last change, or sooner to keep room in storage.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, PURGE_AFTER_MS, PURGE_BATCH, STORAGE_HEADROOM, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage, type Collection } from '../../src/core/storage.ts';
import type { Card } from '../../src/core/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const agent: Caller = { token: 'ta', role: 'agent' };
const owner: Caller = { token: 'to', role: 'owner' };
// A 1x1 PNG.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const file = { src: `data:text/markdown;base64,${Buffer.from('# notes').toString('base64')}`, name: 'notes.md' };

function setup() {
  let t = 1_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const store = new MemoryStorage();
  const blobs = new MemoryBlobs();
  const inbox = new Inbox(store, clock.now, blobs);
  return { inbox, clock, store, blobs };
}

const exists = (inbox: Inbox, id: string): boolean => { try { inbox.getCard(id); return true; } catch { return false; } };

describe('the purge of old cards', () => {
  it('deletes a card cleared 30 days ago with its answer, search entry and files, and keeps one cleared since', async () => {
    const { inbox, clock, blobs } = setup();
    const card = await inbox.postCardWithFiles(agent, { id: 'old', agent: 's1', title: 'walrus', attachments: [file] });
    const answer = await inbox.answer('old', { comment: 'see this', images: [{ src: png }] });
    inbox.archive(owner);
    clock.advance(10 * DAY);
    inbox.postCard(agent, { id: 'new', agent: 's1', title: 'narwhal' });
    await inbox.answer('new', {});
    inbox.archive(owner);
    clock.advance(PURGE_AFTER_MS - 10 * DAY - 1);
    assert.deepEqual(await inbox.purge(), { removed: 0 }, 'a card cleared just under 30 days ago stays');
    clock.advance(1);
    assert.deepEqual(await inbox.purge(), { removed: 1 });
    assert.equal(exists(inbox, 'old'), false);
    assert.deepEqual(inbox.search('walrus', 20, true), []);
    assert.equal(await blobs.get(card.attachments![0]!.id!), undefined);
    assert.equal(await blobs.get(answer.images![0]!.id!), undefined);
    assert.equal(exists(inbox, 'new'), true);
    assert.equal(inbox.search('narwhal', 20, true).length, 1);
  });

  it('deletes an unanswered card 30 days after its last revision, and never an answered card on show', async () => {
    const { inbox, clock } = setup();
    inbox.postCard(agent, { id: 'waiting', agent: 's1', title: 'q' });
    inbox.postCard(agent, { id: 'revised', agent: 's1', title: 'q' });
    inbox.postCard(agent, { id: 'answered', agent: 's1', title: 'q' });
    await inbox.answer('answered', {});
    clock.advance(20 * DAY);
    inbox.postCard(agent, { id: 'revised', agent: 's1', title: 'q, again' });
    clock.advance(PURGE_AFTER_MS - 20 * DAY);
    assert.deepEqual(await inbox.purge(), { removed: 1 });
    assert.equal(exists(inbox, 'waiting'), false);
    assert.equal(exists(inbox, 'revised'), true);
    clock.advance(20 * DAY);
    assert.deepEqual(await inbox.purge(), { removed: 1 });
    clock.advance(365 * DAY);
    assert.deepEqual(await inbox.purge(), { removed: 0 });
    assert.equal(exists(inbox, 'answered'), true, 'the person has not cleared it');
  });

  it(`deletes at most ${PURGE_BATCH} cards a pass, oldest first, and asks the alarm back at once while more are due`, async () => {
    const { inbox, clock } = setup();
    const n = PURGE_BATCH + 50;
    for (let i = 0; i < n; i++) {
      inbox.postCard(agent, { id: `c${i}`, agent: 's1', title: 'q' });
      clock.advance(1000);
    }
    clock.advance(PURGE_AFTER_MS);
    assert.deepEqual(await inbox.purge(), { removed: PURGE_BATCH });
    assert.equal(exists(inbox, `c${PURGE_BATCH - 1}`), false);
    assert.equal(exists(inbox, `c${PURGE_BATCH}`), true);
    assert.ok((inbox.nextDeadline() ?? Infinity) <= clock.now(), 'cards still due bring the alarm back');
    assert.deepEqual(await inbox.purge(), { removed: 50 });
    assert.equal(inbox.nextDeadline(), undefined);
  });

  it('names the earliest purge time as the next deadline, so an idle inbox wakes for it', async () => {
    const { inbox, clock } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    await inbox.answer('c1', {});
    const cleared = clock.now();
    inbox.archive(owner);
    assert.equal(inbox.nextDeadline(), cleared + PURGE_AFTER_MS);
    clock.advance(DAY);
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'q' });
    assert.equal(inbox.nextDeadline(), cleared + PURGE_AFTER_MS);
    clock.advance(DAY);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q, revised' });
    assert.equal(inbox.nextDeadline(), clock.now() - DAY + PURGE_AFTER_MS, 'a revision brings the cleared card back, so c2 is next');
  });

  it(`deletes cards sooner, oldest first, to keep ${STORAGE_HEADROOM * 100}% of the storage limit free`, async () => {
    const { store, clock, blobs } = setup();
    const filler = new Inbox(store, clock.now, blobs);
    const text = 'x'.repeat(10_000);
    filler.postCard(agent, { id: 'answered', agent: 's1', title: 'q', text });
    await filler.answer('answered', {});
    for (let i = 0; i < 10; i++) {
      filler.postCard(agent, { id: `c${i}`, agent: 's1', title: 'q', text });
      clock.advance(1000);
    }
    const limit = Math.floor(store.bytes() / 0.9);
    const inbox = new Inbox(store, clock.now, blobs, { storageLimitBytes: limit });
    assert.equal(inbox.nextDeadline(), clock.now(), 'a fuller inbox purges at once');
    const { removed } = await inbox.purge();
    assert.ok(store.bytes() <= limit * (1 - STORAGE_HEADROOM));
    assert.ok(removed > 0 && removed < 10, `removed ${removed}`);
    for (let i = 0; i < 10; i++) assert.equal(exists(inbox, `c${i}`), i >= removed, `c${i}`);
    assert.equal(exists(inbox, 'answered'), true);
    assert.ok((inbox.nextDeadline() ?? 0) > clock.now(), 'with the headroom back, nothing is due');
  });

  it('keeps an answered card on show even when the storage limit is near', async () => {
    const { store, clock, blobs } = setup();
    const filler = new Inbox(store, clock.now, blobs);
    filler.postCard(agent, { id: 'answered', agent: 's1', title: 'q', text: 'x'.repeat(10_000) });
    await filler.answer('answered', {});
    const inbox = new Inbox(store, clock.now, blobs, { storageLimitBytes: store.bytes() });
    assert.equal(inbox.nextDeadline(), undefined);
    assert.deepEqual(await inbox.purge(), { removed: 0 });
  });

  it('finds the cards it purges in the summaries and the oldest cleared rows, and reads only the whole cards it deletes', async () => {
    const { inbox, clock, store } = setup();
    for (let i = 0; i < 5; i++) inbox.postCard(agent, { id: `c${i}`, agent: 's1', title: 'q' });
    await inbox.answer('c0', {});
    await inbox.answer('c1', {});
    inbox.archive(owner);
    clock.advance(PURGE_AFTER_MS);
    const read: string[] = [];
    const list = store.list.bind(store);
    const get = store.get.bind(store);
    store.list = <T>(c: Collection): T[] => { read.push(`list ${c}`); return list<T>(c); };
    store.get = <T>(c: Collection, id: string): T | undefined => { if (c === 'cards') read.push(`get ${id}`); return get<T>(c, id); };
    inbox.nextDeadline();
    assert.deepEqual(await inbox.purge(), { removed: 5 });
    assert.equal(read.filter((r) => r === 'list cards').length, 1, 'only nextDeadline lists the cards, for its triage and expiry times');
    assert.equal(read.includes('list cleared'), false, `it reads the oldest ${PURGE_BATCH} cleared rows, never all of them`);
    assert.deepEqual([...new Set(read.filter((r) => r.startsWith('get ')))].sort(), ['get c0', 'get c1', 'get c2', 'get c3', 'get c4']);
  });

  it('purges a card cleared before the inbox kept its list of cleared cards', async () => {
    const store = new MemoryStorage();
    store.put('cards', 'old', { id: 'old', agent: 's', kind: 'ask', title: 'Old card', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, archivedAt: 1, replies: [] } satisfies Card);
    store.put('meta', 'summaries', { key: 'summaries', version: 1 });
    const inbox = new Inbox(store, () => 1 + PURGE_AFTER_MS);
    assert.deepEqual(await inbox.purge(), { removed: 1 });
  });

  it('finishes the pass when a file delete fails, since the records are gone and R2 expires the file', async () => {
    const { inbox, clock, blobs } = setup();
    await inbox.postCardWithFiles(agent, { id: 'old', agent: 's1', title: 'q', attachments: [file] });
    blobs.delete = async () => { throw new Error('R2 is down'); };
    clock.advance(PURGE_AFTER_MS);
    assert.deepEqual(await inbox.purge(), { removed: 1 });
    assert.equal(exists(inbox, 'old'), false);
  });

  it('drops a queue row whose card is gone, so the alarm does not come back for it forever', async () => {
    const { inbox, clock, store } = setup();
    store.put('cleared', 'ghost', { id: 'ghost', archivedAt: clock.now() });
    clock.advance(PURGE_AFTER_MS);
    assert.deepEqual(await inbox.purge(), { removed: 0 });
    assert.equal(inbox.nextDeadline(), undefined);
  });
});

describe('a file delete that fails', () => {
  it('is retried on the next pass, so a laptop does not leave the file on disk for good', async () => {
    let t = 1_000_000_000;
    const store = new MemoryStorage();
    const blobs = new MemoryBlobs();
    let fail = true;
    const flaky = {
      put: blobs.put.bind(blobs),
      get: blobs.get.bind(blobs),
      delete: async (key: string) => { if (fail) throw new Error('EACCES'); return blobs.delete(key); },
    };
    const inbox = new Inbox(store, () => t, flaky);
    const card = await inbox.postCardWithFiles(agent, { id: 'old', agent: 's1', title: 'walrus', attachments: [file] });
    const fileId = card.attachments?.[0]?.id ?? '';
    assert.equal((await blobs.get(fileId)) !== undefined, true, 'the file is stored');
    inbox.archive(owner);
    t += 31 * DAY;
    await inbox.purge();
    assert.equal((await blobs.get(fileId)) !== undefined, true, 'the failed delete leaves the file');
    fail = false;
    await inbox.purge();
    assert.equal(await blobs.get(fileId), undefined, 'the next pass removes it');
  });
});
