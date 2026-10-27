// Card features from the batch of principles about the card model.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, ORPHAN_MS, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
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
