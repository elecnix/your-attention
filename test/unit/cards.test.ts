// Card features from the batch of principles about the card model.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, ORPHAN_MS, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const inbox = new Inbox(new MemoryStorage(), clock.now);
  const agent: Caller = { token: 'ta', role: 'agent' };
  return { inbox, clock, agent };
}

describe('patch edits', () => {
  it('replaces text that occurs once, and keeps the earlier version', () => {
    const { inbox, agent } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Spec', text: 'Use SQLite for storage.\nKeep one writer.' });
    const next = inbox.patchCard(agent, 'c1', [{ old: 'SQLite', new: 'SQLite with FTS5' }]);
    assert.equal(next.text, 'Use SQLite with FTS5 for storage.\nKeep one writer.');
    assert.equal(next.version, 2);
    assert.equal(next.history?.[0]?.text, 'Use SQLite for storage.\nKeep one writer.');
  });

  it('refuses an edit whose old text is missing or repeated', () => {
    const { inbox, agent } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Spec', body: 'a = 1\na = 1' });
    assert.throws(() => inbox.patchCard(agent, 'c1', [{ old: 'a = 1', new: 'a = 2' }]), (e: unknown) => e instanceof InboxError && e.status === 409);
    assert.throws(() => inbox.patchCard(agent, 'c1', [{ old: 'b', new: 'c' }]), /occurs 0 times/);
    assert.throws(() => inbox.patchCard(agent, 'c1', [{ old: 'a', new: 'b' }], 'secret'), /field must be/);
  });

  it('keeps at most 20 earlier versions', () => {
    const { inbox, agent } = setup();
    for (let i = 0; i < 25; i++) inbox.postCard(agent, { id: 'c1', agent: 's1', title: `v${i}` });
    const card = inbox.getCard('c1');
    assert.equal(card.history?.length, 20);
    assert.equal(card.history?.at(-1)?.title, 'v23');
  });
});

describe('card states', () => {
  it('lets an agent label its own card', () => {
    const { inbox, agent } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    assert.equal(inbox.setStatus(agent, 'c1', 'waiting on CI').status, 'waiting on CI');
    assert.equal(inbox.setStatus(agent, 'c1', '').status, undefined);
    assert.throws(() => inbox.setStatus({ token: 'other', role: 'agent' }, 'c1', 'x'), /another client/);
  });

  it('expires a card nobody answered', () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q', expiresAt: clock.now() + 1000 });
    inbox.sweep();
    assert.equal(inbox.state().states['c1'], 'open');
    clock.advance(1001);
    inbox.sweep();
    assert.equal(inbox.state().states['c1'], 'closed');
    assert.equal(inbox.getCard('c1').closed?.kind, 'expired');
  });

  it('marks an open card orphaned once its agent has been gone an hour', () => {
    const { inbox, agent, clock } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    inbox.connect(agent, 's1', () => {})();
    assert.equal(inbox.state().states['c1'], 'open');
    clock.advance(ORPHAN_MS + 1);
    inbox.sweep();
    assert.equal(inbox.state().states['c1'], 'orphaned');
  });
});

describe('templates', () => {
  it('fills a card body from the latest version, or a pinned one', () => {
    const { inbox, agent } = setup();
    inbox.saveTemplate('review', 'root = Card([TextContent({{statement}})])');
    inbox.saveTemplate('review', 'root = Card([CardHeader({{statement}})])', 'Show the statement as a header.');
    const latest = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q', template: { name: 'review', vars: { statement: 'Use "one" writer' } } });
    assert.equal(latest.body, 'root = Card([CardHeader("Use \\"one\\" writer")])');
    assert.deepEqual(latest.template, { name: 'review', version: 2 });
    const pinned = inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'q', template: { name: 'review', version: 1, vars: {} } });
    assert.equal(pinned.body, 'root = Card([TextContent("")])');
    assert.equal(inbox.getTemplate('review').versions[1]?.feedback, 'Show the statement as a header.');
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'q', template: { name: 'missing' } }), /unknown template/);
  });
});

describe('priority levels', () => {
  it('accepts renamed levels and applies a rule before the agent priority', () => {
    const { inbox, agent, clock } = setup();
    inbox.setPriorities([
      { id: 'urgent', label: 'Urgent', definition: 'Blocked work', rule: 'blocked || waitMinutes > 30' },
      { id: 'normal', label: 'Normal', definition: 'Everything else' },
    ]);
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'q', priority: 'soon' }), /priority must be one of urgent, normal/);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q', priority: 'normal' });
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'b', kind: 'blocked', priority: 'normal', deliver: 'none' });
    assert.equal(inbox.state().priorities['c1'], 'normal');
    assert.equal(inbox.state().priorities['c2'], 'urgent');
    clock.advance(31 * 60 * 1000);
    assert.equal(inbox.state().priorities['c1'], 'urgent');
  });

  it('refuses a rule that does not parse', () => {
    const { inbox } = setup();
    assert.throws(() => inbox.setPriorities([{ id: 'x', label: 'X', definition: '', rule: 'process.exit()' }]), /level 1/);
  });
});

describe('guidance', () => {
  it('sends approved guidance to the agents the person picked, and to nobody else', async () => {
    const { inbox, agent } = setup();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    inbox.connect(agent, 's1', (e) => a.push(e));
    inbox.connect(agent, 's2', (e) => b.push(e));
    const card = inbox.proposeGuidance('Always include a diff.');
    assert.deepEqual(card.broadcast?.agents.sort(), ['s1', 's2']);
    assert.equal(inbox.guidance().version, 1, 'nothing changes before approval');
    await inbox.answer(card.id, { values: { choice: 'approve', agents: ['s1'] } });
    assert.equal(inbox.guidance().text, 'Always include a diff.');
    assert.equal(a.filter((e) => e.type === 'guidance').length, 1);
    assert.equal(b.filter((e) => e.type === 'guidance').length, 0);
  });

  it('leaves guidance as it was when the person rejects it', async () => {
    const { inbox } = setup();
    const card = inbox.proposeGuidance('Never mind.');
    await inbox.answer(card.id, { values: { choice: 'reject' } });
    assert.equal(inbox.guidance().version, 1);
    assert.equal(inbox.getCard(card.id).closed?.kind, 'resolved');
  });
});

describe('settings', () => {
  it('keeps raw HTML off until the owner turns it on', () => {
    const { inbox } = setup();
    assert.equal(inbox.settings().allowHtml, false);
    assert.equal(inbox.setSettings({ allowHtml: true }).allowHtml, true);
  });
});

describe('attachments', () => {
  // A 1x1 PNG.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const b64 = (text: string) => Buffer.from(text).toString('base64');

  it('stores each file in the blob store and serves its bytes back', async () => {
    const { inbox, agent } = setup();
    const card = await inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'Review these', attachments: [
      { src: png, name: 'layout-a.png', alt: 'Layout A' },
      { src: `data:text/markdown;base64,${b64('# Plan\n\n- one')}`, name: 'plan.md' },
      { src: 'https://example.com/docs/spec.pdf' },
    ] });
    assert.equal(card.attachments?.length, 3);
    assert.doesNotMatch(JSON.stringify(card), /iVBOR/);
    const first = await inbox.attachment(agent, card.attachments![0]!.id!);
    assert.equal(first.file.type, 'image/png');
    assert.equal(Buffer.from(first.bytes).subarray(1, 4).toString(), 'PNG');
    assert.equal(Buffer.from((await inbox.attachment(agent, card.attachments![1]!.id!)).bytes).toString(), '# Plan\n\n- one');
    assert.deepEqual(card.attachments?.[2], { url: 'https://example.com/docs/spec.pdf', name: 'spec.pdf', type: 'application/pdf', alt: undefined });
    await assert.rejects(inbox.attachment({ token: 'other', role: 'agent' }, card.attachments![0]!.id!), /another client/);
  });

  it('keeps a large file whole in the blob store', async () => {
    const { inbox, agent } = setup();
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    const card = await inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [{ src: `data:application/pdf;base64,${bytes.toString('base64')}`, name: 'big.pdf' }] });
    const back = await inbox.attachment(agent, card.attachments![0]!.id!);
    assert.equal(back.bytes.length, bytes.length);
    assert.equal(back.bytes[bytes.length - 1], 7);
  });

  it('keeps the files when the agent revises the text, and deletes them when it sends new ones', async () => {
    const { inbox, agent } = setup();
    const first = await inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', text: 'a', attachments: [{ src: png, alt: 'one' }] });
    assert.equal(inbox.patchCard(agent, 'c1', [{ old: 'a', new: 'b' }]).attachments?.[0]?.id, first.attachments?.[0]?.id);
    const next = await inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [{ src: png, alt: 'two' }] });
    assert.notEqual(next.attachments?.[0]?.id, first.attachments?.[0]?.id);
    await assert.rejects(inbox.attachment(agent, first.attachments![0]!.id!), /unknown attachment/);
  });

  it('refuses files it cannot take', async () => {
    const { inbox, agent } = setup();
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'q', attachments: [{ src: 'http://example.com/x.png' }] }), /https URL/);
    await assert.rejects(inbox.postCardWithFiles(agent, { agent: 's1', title: 'q', attachments: Array(11).fill({ src: png }) }), /at most 10/);
    const big = `data:application/pdf;base64,${'A'.repeat(12_000_000)}`;
    await assert.rejects(inbox.postCardWithFiles(agent, { agent: 's1', title: 'q', attachments: [{ src: big }] }), (e: unknown) => e instanceof InboxError && e.status === 413);
    await assert.rejects(inbox.postCardWithFiles(agent, { agent: 's1', title: ' ', attachments: [{ src: png }] }), /title/);
  });
});

describe('attachment edge cases from review', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('serves an attachment on a card whose id contains a dot', async () => {
    const { inbox, agent } = setup();
    const card = await inbox.postCardWithFiles(agent, { id: 'v1.2.review', agent: 's1', title: 'q', attachments: [{ src: png }] });
    assert.equal((await inbox.attachment(agent, card.attachments![0]!.id!)).file.type, 'image/png');
  });

  it('answers 400 to every malformed attachment, never a crash', async () => {
    const { inbox, agent } = setup();
    for (const bad of [null, 'x', { src: 'https://' }, { src: 'https://example.com/%E0%A4%A' }, { src: 'data:image/png;base64,A' }]) {
      await assert.rejects(inbox.postCardWithFiles(agent, { agent: 's1', title: 'q', attachments: [bad as never] }), (e: unknown) => e instanceof InboxError && e.status === 400, JSON.stringify(bad));
    }
    await assert.rejects(inbox.postCardWithFiles(agent, { id: '../../x', agent: 's1', title: 'q', attachments: [{ src: png }] }), /id must be/);
  });

  it('deletes the files a concurrent update replaced', async () => {
    const store = new MemoryStorage();
    const blobs = new MemoryBlobs();
    const inbox = new Inbox(store, Date.now, blobs);
    const agent: Caller = { token: 'ta', role: 'agent' };
    const first = await inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [{ src: png }] });
    const [a, b] = await Promise.all([
      inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [{ src: png }] }),
      inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [{ src: png }] }),
    ]);
    const finalId = inbox.getCard('c1').attachments![0]!.id!;
    for (const id of [first.attachments![0]!.id!, a.attachments![0]!.id!, b.attachments![0]!.id!].filter((x) => x !== finalId)) {
      assert.equal(await blobs.get(id), undefined, `${id} should be gone`);
    }
  });
});

describe('the platform alarm', () => {
  it('names the next moment sweep() has work, and nothing when nothing waits', () => {
    let t = 1000;
    const inbox = new Inbox(new MemoryStorage(), () => t);
    const agent: Caller = { token: 'ta', role: 'agent' };
    assert.equal(inbox.nextDeadline(), undefined);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q', expiresAt: 50_000 });
    assert.equal(inbox.nextDeadline(), 50_000);
    inbox.connect(agent, 's1', () => {})();
    assert.equal(inbox.nextDeadline(), 1000 + 2000);
    t = 3000;
    inbox.sweep();
    assert.equal(inbox.nextDeadline(), 50_000);
  });

  it('adopts a token the deployment chose, and refuses a malformed one', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const secret = `${'a'.repeat(12)}.${'b'.repeat(64)}`;
    await inbox.adoptToken(secret, 'owner from a Worker secret', 'owner');
    assert.equal((await inbox.authenticate(secret))?.role, 'owner');
    await assert.rejects(inbox.adoptToken('short.token', 'x', 'owner'), /12 hex digits/);
  });
});

describe('search over tags and files', () => {
  it('finds a card by a tag value and by a file name', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const agent: Caller = { token: 'ta', role: 'agent' };
    await inbox.postCardWithFiles(agent, { id: 't1', agent: 's1', title: 'q', tags: { topic: 'release' }, attachments: [{ src: 'data:text/plain;base64,aGk=', name: 'rollout-notes.txt' }] });
    assert.equal(inbox.search('release')[0]?.card.id, 't1');
    assert.equal(inbox.search('rollout')[0]?.card.id, 't1');
  });

  it('names the file that is too large', async () => {
    const inbox = new Inbox(new MemoryStorage());
    await assert.rejects(inbox.postCardWithFiles({ token: 'ta', role: 'agent' }, { agent: 's1', title: 'q', attachments: [{ src: `data:application/pdf;base64,${'A'.repeat(12_000_000)}`, name: 'huge.pdf' }] }), /\(huge\.pdf\) is 9000000 bytes/);
  });
});

describe('fixes from the dogfood run', () => {
  it('opens a returned card again when the agent revises it', () => {
    const { inbox, agent } = setup();
    const ext: Caller = { token: 'tx', role: 'extension' };
    const calls: { id: string }[] = [];
    inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e));
    inbox.postCard(agent, { id: 'r1', agent: 's1', title: 'Thoughts?' });
    inbox.hookVerdict(ext, calls[0]!.id, 'return', 'Say what you recommend.');
    assert.equal(inbox.getCard('r1').closed?.kind, 'returned');
    inbox.postCard(agent, { id: 'r1', agent: 's1', title: 'Ship today?', recommendation: 'Yes.' });
    assert.equal(inbox.getCard('r1').closed, undefined);
    inbox.hookVerdict(ext, calls[1]!.id, 'pass', '');
    assert.equal(inbox.state().states['r1'], 'open');
  });

  it('ends a pending triage when the agent closes the card', () => {
    const { inbox, agent } = setup();
    inbox.connectExtension({ token: 'tx', role: 'extension' }, { name: 'triage', hooks: ['card.created'] }, () => {});
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    inbox.close(agent, 'c1', 'retracted', 'Not needed.');
    assert.equal(inbox.getCard('c1').triage?.state, 'skipped');
  });

  it('fills an empty field with a patch whose old text is empty', () => {
    const { inbox, agent } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    assert.equal(inbox.patchCard(agent, 'c1', [{ old: '', new: 'Now with context.' }], 'text').text, 'Now with context.');
  });

  it('applies priority levels an agent proposes only after the person approves', async () => {
    const { inbox } = setup();
    const card = inbox.proposePriorities([{ id: 'only', label: 'Only', definition: '' }]);
    assert.equal(inbox.priorities().length, 3);
    await inbox.answer(card.id, { values: { choice: 'approve' } });
    assert.deepEqual(inbox.priorities().map((l) => l.id), ['only']);
  });

  it('searches answered cards only, when asked', async () => {
    const { inbox, agent } = setup();
    inbox.postCard(agent, { id: 'a1', agent: 's1', title: 'cache size question' });
    inbox.postCard(agent, { id: 'a2', agent: 's1', title: 'cache policy question' });
    await inbox.answer('a2', { comment: 'LRU' });
    assert.equal(inbox.search('cache').length, 2);
    assert.deepEqual(inbox.search('cache', 20, true).map((r) => r.card.id), ['a2']);
  });
});

describe('fixes from the last review', () => {
  it('lets a message id be applied again after a reservation goes stale', () => {
    let t = 0;
    const inbox = new Inbox(new MemoryStorage(), () => t);
    inbox.rememberMessage('k', 0, '');
    assert.equal(inbox.recallMessage('k')?.status, 0);
    t = 31_000;
    assert.equal(inbox.recallMessage('k'), undefined);
  });

  it('leaves an answered card out of the next deadline', async () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1000);
    inbox.postCard({ token: 'ta', role: 'agent' }, { id: 'c1', agent: 's1', title: 'q', expiresAt: 5000 });
    await inbox.answer('c1', {});
    assert.equal(inbox.nextDeadline(), undefined);
  });
});

describe('the upload limit', () => {
  const agent: Caller = { token: 'ta', role: 'agent' };
  const file = (n: number) => ({ src: `data:application/octet-stream;base64,${Buffer.alloc(n, 1).toString('base64')}`, name: 'f.bin' });

  it('counts every byte an inbox has stored, and refuses files past its lifetime limit', async () => {
    const inbox = new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs(), { uploadLimitBytes: 1000 });
    await inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [file(600)] });
    await assert.rejects(inbox.postCardWithFiles(agent, { id: 'c2', agent: 's1', title: 'q', attachments: [file(500)] }),
      (e: unknown) => e instanceof InboxError && e.status === 413 && /lifetime limit/.test(e.message));
    // Deleting files gives no bytes back: the limit counts what was ever uploaded.
    await inbox.reset({ token: 'o', role: 'owner' });
    await assert.rejects(inbox.postCardWithFiles(agent, { id: 'c3', agent: 's1', title: 'q', attachments: [file(500)] }), /lifetime limit/);
    await inbox.postCardWithFiles(agent, { id: 'c4', agent: 's1', title: 'q', attachments: [file(400)] });
    assert.deepEqual(inbox.uploads(), { used: 1000, limit: 1000 });
  });

  it('gives the bytes back when the card is refused', async () => {
    const inbox = new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs(), { uploadLimitBytes: 1000 });
    await assert.rejects(inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: ' ', attachments: [file(600)] }), /title/);
    assert.equal(inbox.uploads().used, 0);
  });

  it('deletes every file and gives the bytes back when one file fails to store', async () => {
    const blobs = new MemoryBlobs();
    const put = blobs.put.bind(blobs);
    let n = 0;
    blobs.put = async (key, bytes, type) => {
      if (n++ === 0) throw new Error('the store is down');
      await new Promise((r) => setTimeout(r, 20));
      return put(key, bytes, type);
    };
    const del: string[] = [];
    const remove = blobs.delete.bind(blobs);
    blobs.delete = async (key) => { del.push(key); return remove(key); };
    const inbox = new Inbox(new MemoryStorage(), Date.now, blobs, { uploadLimitBytes: 1000 });
    await assert.rejects(inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [file(100), file(100), file(100)] }), /store is down/);
    assert.equal(del.length, 3);
    for (const key of del) assert.equal(await blobs.get(key), undefined);
    assert.equal(inbox.uploads().used, 0);
  });

  it('has no limit unless one is set', async () => {
    const inbox = new Inbox(new MemoryStorage());
    await inbox.postCardWithFiles(agent, { id: 'c1', agent: 's1', title: 'q', attachments: [file(600)] });
    assert.deepEqual(inbox.uploads(), { used: 600, limit: undefined });
  });
});
