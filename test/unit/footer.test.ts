// `your-attention footer` prints one status-line segment: how many cards wait for the person, then an OSC 8 link to
// each of the first few, in the page's queue order. These tests pin the count, the order, the links, and the cases
// where the segment says nothing: an empty inbox, and an inbox that does not answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_PRIORITIES, Inbox } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { NewCard } from '../../src/core/types.ts';
import { footerSegment, footerState, footerTarget } from '../../src/footer.ts';
import type { InboxState } from '../../web/queue.js';
import { agent } from './fixture.ts';

const URL = 'http://127.0.0.1:4815';

/** The exact bytes of one digit linking to a card, as the segment prints it. */
const link = (id: string, digit: number): string => `\x1b]8;;${URL}/#card=${id}\x07${digit}\x1b]8;;\x07`;

/** An inbox in memory whose clock advances a minute between the cards a test posts, so arrival order is the posting order. */
function setup(): { inbox: Inbox; post: (id: string, card?: Partial<NewCard>) => void } {
  let now = 1_800_000_000_000;
  const inbox = new Inbox(new MemoryStorage(), () => now, new MemoryBlobs());
  return {
    inbox,
    post: (id, card = {}) => {
      inbox.postCard(card.kind === 'system' ? { token: '', role: 'owner' } : agent, { id, agent: 's1', title: `Card ${id}`, ...card });
      now += 60_000;
    },
  };
}

/** The segment of an inbox's state, as `your-attention footer` prints it. */
const segment = (inbox: Inbox, max = 5): string => footerSegment(inbox.summaryState(), URL, max);

describe('footerSegment', () => {
  it('prints nothing for an inbox with no card waiting', () => {
    const { inbox } = setup();
    assert.equal(segment(inbox), '');
  });

  it('counts one waiting card and links it as 1', () => {
    const { inbox, post } = setup();
    post('c1');
    assert.equal(segment(inbox), `1 card ${link('c1', 1)}`);
  });

  it('counts every waiting card and links the first ones in arrival order', () => {
    const { inbox, post } = setup();
    post('c1');
    post('c2');
    post('c3');
    assert.equal(segment(inbox), `3 cards ${link('c1', 1)} ${link('c2', 2)} ${link('c3', 3)}`);
  });

  it('orders the links by priority level before arrival', () => {
    const { inbox, post } = setup();
    post('later', { priority: 'later' });
    post('now', { priority: 'now' });
    post('soon', { priority: 'soon' });
    assert.equal(segment(inbox), `3 cards ${link('now', 1)} ${link('soon', 2)} ${link('later', 3)}`);
  });

  it('counts only the cards that wait for the person: not an answered or a closed one', async () => {
    const { inbox, post } = setup();
    post('c1');
    post('c2');
    post('c3');
    await inbox.answer('c2', { values: { choice: 'o1' } });
    inbox.close(agent, 'c3', 'resolved', 'No longer needed.');
    assert.equal(segment(inbox), `1 card ${link('c1', 1)}`);
  });

  it('counts a held or an orphaned card, and not one triage is still checking', () => {
    const state = (states: Record<string, string>): InboxState => ({
      cards: [{ id: 'c1', agent: 's1', kind: 'ask', title: 'Card c1', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, rev: 'r1' }],
      answers: {},
      presence: {},
      states: states as InboxState['states'],
      levels: DEFAULT_PRIORITIES,
      settings: { allowHtml: false },
    });
    for (const waiting of ['open', 'held', 'orphaned']) assert.equal(footerSegment(state({ c1: waiting }), URL), `1 card ${link('c1', 1)}`, waiting);
    for (const gone of ['in-triage', 'answered', 'delivered', 'read', 'closed']) assert.equal(footerSegment(state({ c1: gone }), URL), '', gone);
  });

  it('puts the inbox’s own system cards first', () => {
    const { inbox, post } = setup();
    post('c1');
    post('sys', { kind: 'system', priority: 'later', system: { type: 'subscribe', webhook: { url: 'https://hook.test/a' } } });
    assert.equal(segment(inbox), `2 cards ${link('sys', 1)} ${link('c1', 2)}`);
  });

  it('puts a pinned group before the rest of the queue', () => {
    const { inbox, post } = setup();
    post('c1');
    post('c2', { agent: 's2' });
    inbox.setSettings({ pins: [{ agent: 's2' }] });
    assert.equal(segment(inbox), `2 cards ${link('c2', 1)} ${link('c1', 2)}`);
  });

  it('cuts the links to --max and keeps the count', () => {
    const { inbox, post } = setup();
    post('c1');
    post('c2');
    post('c3');
    assert.equal(segment(inbox, 2), `3 cards ${link('c1', 1)} ${link('c2', 2)}`);
    assert.equal(segment(inbox, 0), '3 cards');
  });

  it('keeps control bytes out of the link target', () => {
    const { inbox, post } = setup();
    post('c1');
    const out = footerSegment(inbox.summaryState(), 'http://a.test/\x1b]8;;http://evil.test\x07');
    assert.ok(!out.includes('\x07http://evil.test'), out);
    assert.ok(!out.includes('\x1b]8;;http://evil.test'), out);
    assert.ok(out.includes('\x1b]8;;http://a.test/]8;;http://evil.test/#card=c1\x071\x1b]8;;\x07'), out);
  });
});

describe('footerTarget', () => {
  const withHome = (files: Record<string, string>, run: (home: string) => void): void => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-footer-'));
    try {
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(home, name), text, { mode: 0o600 });
      run(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it('finds no inbox in an empty home with no variables', () => {
    withHome({}, (home) => assert.equal(footerTarget({}, home), undefined));
  });

  it('reads YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN first', () => {
    withHome({ 'server.json': JSON.stringify({ url: 'http://local.test' }), 'owner-token': 'to' }, (home) => {
      const target = footerTarget({ YOUR_ATTENTION_URL: 'http://env.test/', YOUR_ATTENTION_TOKEN: 'te' }, home);
      assert.deepEqual(target, { url: 'http://env.test', token: 'te', source: 'YOUR_ATTENTION_URL' });
    });
  });

  it('reads the inbox this machine runs before a pairing', () => {
    withHome({
      'server.json': JSON.stringify({ url: 'http://local.test/' }),
      'owner-token': 'to\n',
      'owner.json': JSON.stringify({ url: 'http://paired.test', token: 'tp' }),
    }, (home) => {
      const target = footerTarget({}, home);
      assert.deepEqual(target, { url: 'http://local.test', token: 'to', source: path.join(home, 'owner-token') });
    });
  });

  it('reads an owner pairing when this machine runs no inbox', () => {
    withHome({ 'owner.json': JSON.stringify({ url: 'http://paired.test/', token: 'tp' }) }, (home) => {
      const target = footerTarget({}, home);
      assert.deepEqual(target, { url: 'http://paired.test', token: 'tp', source: path.join(home, 'owner.json') });
    });
  });

  it('needs both variables: one alone finds the files instead', () => {
    withHome({ 'server.json': JSON.stringify({ url: 'http://local.test' }), 'owner-token': 'to' }, (home) => {
      assert.equal(footerTarget({ YOUR_ATTENTION_URL: 'http://env.test' }, home)?.url, 'http://local.test');
      assert.equal(footerTarget({ YOUR_ATTENTION_TOKEN: 'te' }, home)?.url, 'http://local.test');
    });
  });
});

describe('footerState', () => {
  it('answers undefined for an inbox that does not answer', async () => {
    // A closed loopback port refuses at once, so the test stays fast and never touches a real inbox.
    assert.equal(await footerState({ url: 'http://127.0.0.1:9', token: 't' }), undefined);
  });

  it('answers undefined for a reply that is not a state', async () => {
    const reply = async (body: unknown): Promise<InboxState | undefined> => {
      const server = (await import('node:http')).createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/v1/state' ? JSON.stringify(body) : JSON.stringify({ error: 'no' }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      try {
        return await footerState({ url: `http://127.0.0.1:${port}`, token: 't' });
      } finally {
        server.close();
      }
    };
    assert.equal(await reply({ hello: 'world' }), undefined);
    // A card with no object could never render, and the queue would throw on it: the whole reply counts as no state.
    assert.equal(await reply({ cards: [null], answers: {}, presence: {}, states: {} }), undefined);
    assert.equal(await reply({ cards: [{ title: 'no id' }], answers: {}, presence: {}, states: {} }), undefined);
  });

  it('renders a state whose settings carry pins of the wrong shape', () => {
    // A settings object passes the check, but a string where the pins go is not the queue's business.
    const state = {
      cards: [{ id: 'c1', agent: 's1', kind: 'ask', title: 'Card c1', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, rev: 'r1' }],
      answers: {},
      presence: {},
      states: { c1: 'open' },
      levels: DEFAULT_PRIORITIES,
      settings: { allowHtml: false, pins: 'nope', groupBy: 7 },
    } as unknown as InboxState;
    assert.equal(footerSegment(state, URL), `1 card ${link('c1', 1)}`);
  });
});
