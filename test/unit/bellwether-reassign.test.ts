// The Bellwether watcher: a retirement in retire.log hands each card of the retired agent, and of its descendants that no
// longer run, to the nearest living ancestor, as Bellwether's parent records describe the tree. A stream that goes
// quiet is not a retirement, and moves nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ORPHAN_MS } from '../../src/core/inbox.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { agentOf, sessionId, Tree, type BellwetherChild, type BellwetherParent } from '../../src/integrations/bellwether/ancestry.ts';
import { readRetirements, watchRetirements, type ReassignInbox } from '../../src/integrations/bellwether/watch.ts';
import { presenceOf } from '../../web/queue.js';
import { setup } from './fixture.ts';

/** A Bellwether home in a temporary folder: parent records and a retire.log. */
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'));
  fs.mkdirSync(path.join(dir, 'parents'));
  const parents = new Map<string, BellwetherParent>();
  const write = (p: BellwetherParent) => { parents.set(p.id, p); fs.writeFileSync(path.join(dir, 'parents', `${p.id}.json`), JSON.stringify(p)); };
  return {
    dir,
    cursor: path.join(dir, 'cursor.json'),
    /** A session that has children, and the child id it has itself in its own parent's file. */
    parent(session: string, childId?: string, children: BellwetherChild[] = []) {
      write({ id: `claude-code-${session}`, harness: 'claude-code', session, ...(childId ? { childId } : {}), children });
    },
    /** Add a child to a parent's file. */
    child(parentSession: string, c: { id: string; name: string; session: string; exited?: boolean; harness?: string; kind?: string }) {
      const p = parents.get(`claude-code-${parentSession}`) ?? { id: `claude-code-${parentSession}`, harness: 'claude-code', session: parentSession, children: [] };
      p.children.push({ id: c.id, name: c.name, harness: c.harness ?? 'claude-code', session: { kind: c.kind ?? 'id', value: c.session }, startedAt: '2026-11-27T08:00:00.000Z', ...(c.exited ? { exitedAt: '2026-11-27T09:00:00.000Z' } : {}) });
      write(p);
    },
    /** Bellwether retires a child: it marks the record, then appends the line. */
    retire(parentSession: string, childId: string, name: string) {
      const p = parents.get(`claude-code-${parentSession}`)!;
      const c = p.children.find((x) => x.id === childId)!;
      c.exitedAt ??= '2026-11-27T10:00:00.000Z';
      c.retiredAt = '2026-11-27T10:00:01.000Z';
      write(p);
      fs.appendFileSync(path.join(dir, 'retire.log'), `${JSON.stringify({ at: c.retiredAt, parent: p.id, child: childId, name, outcome: 'removed' })}\n`);
    },
  };
}

/** The owner's calls the watcher makes, on an inbox in memory. */
function ownerOf(t: ReturnType<typeof setup>): ReassignInbox {
  return {
    state: async () => t.inbox.summaryState(),
    reassign: async (id, input) => t.inbox.reassign(t.owner, id, input),
  };
}

async function once(t: ReturnType<typeof setup>, h: ReturnType<typeof home>): Promise<string[]> {
  const lines: string[] = [];
  await watchRetirements({ inbox: ownerOf(t), home: h.dir, cursorFile: h.cursor, signal: new AbortController().signal, once: true, now: t.clock.now, log: (l) => lines.push(l) });
  return lines;
}

/** Connect an agent and keep the events its stream receives. */
function listen(t: ReturnType<typeof setup>, agent: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  t.inbox.connect(t.agent, agent, (ev) => events.push(ev));
  return events;
}

describe('reassigning the cards of a retired agent up the Bellwether tree', () => {
  it('gives a card whose agent retired to its living parent, and tells the parent', async () => {
    const t = setup();
    const h = home();
    h.parent('root');
    h.child('root', { id: 'k1', name: 'fix-login', session: 'kid' });
    const told = listen(t, 'claude:root');
    t.inbox.postCard(t.agent, { id: 'c1', agent: 'claude:kid', title: 'Which schema?' });
    h.retire('root', 'k1', 'fix-login');
    const lines = await once(t, h);
    const card = t.inbox.getCard('c1');
    assert.equal(card.agent, 'claude:root');
    assert.deepEqual(card.reassignedFrom?.map((r) => [r.from, r.to, r.why]), [['claude:kid', 'claude:root', 'fix-login retired']]);
    const notice = told.find((e) => e.type === 'reassigned');
    assert.ok(notice && notice.type === 'reassigned');
    assert.equal(notice.card.id, 'c1');
    assert.equal(notice.why, 'fix-login retired');
    assert.deepEqual(lines, ['card c1: claude:kid to claude:root, because fix-login retired']);
  });

  it('skips a parent that no longer runs, and lands on the nearest living ancestor, not the root', async () => {
    const t = setup();
    const h = home();
    // root > lead (running) > worker (exited) > tester (retires)
    h.parent('root');
    h.child('root', { id: 'k-lead', name: 'lead', session: 'lead' });
    h.parent('lead', 'k-lead');
    h.child('lead', { id: 'k-worker', name: 'worker', session: 'worker', exited: true });
    h.parent('worker', 'k-worker');
    h.child('worker', { id: 'k-tester', name: 'tester', session: 'tester' });
    listen(t, 'claude:root');
    t.inbox.postCard(t.agent, { id: 'c1', agent: 'claude:tester', title: 'q' });
    h.retire('worker', 'k-tester', 'tester');
    await once(t, h);
    assert.equal(t.inbox.getCard('c1').agent, 'claude:lead');
  });

  it('moves the card of a descendant that no longer runs, and leaves one that still runs', async () => {
    const t = setup();
    const h = home();
    h.parent('root');
    h.child('root', { id: 'k-mid', name: 'mid', session: 'mid' });
    h.parent('mid', 'k-mid');
    h.child('mid', { id: 'k-gone', name: 'gone', session: 'gone', exited: true });
    h.child('mid', { id: 'k-busy', name: 'busy', session: 'busy' });
    listen(t, 'claude:root');
    t.inbox.postCard(t.agent, { id: 'c-gone', agent: 'claude:gone', title: 'q' });
    t.inbox.postCard(t.agent, { id: 'c-busy', agent: 'claude:busy', title: 'q' });
    h.retire('root', 'k-mid', 'mid');
    await once(t, h);
    assert.equal(t.inbox.getCard('c-gone').agent, 'claude:root');
    assert.equal(t.inbox.getCard('c-gone').reassignedFrom?.[0]?.why, 'mid retired', 'the reason names the agent that retired');
    assert.equal(t.inbox.getCard('c-busy').agent, 'claude:busy');
  });

  it('with no living ancestor, leaves the card orphaned with the reason, addressed to the person', async () => {
    const t = setup();
    const h = home();
    // The root's session never connected to the inbox, or left more than an hour ago.
    h.parent('root');
    h.child('root', { id: 'k1', name: 'fix-login', session: 'kid' });
    t.inbox.connect(t.agent, 'claude:root', () => {})();
    t.clock.advance(ORPHAN_MS + 1);
    t.inbox.postCard(t.agent, { id: 'c1', agent: 'claude:kid', title: 'q' });
    t.inbox.connect(t.agent, 'claude:kid', () => {});
    h.retire('root', 'k1', 'fix-login');
    const lines = await once(t, h);
    const state = t.inbox.summaryState();
    assert.equal(state.states['c1'], 'orphaned');
    assert.equal(t.inbox.getCard('c1').agent, 'claude:kid');
    assert.match(presenceOf(t.inbox.getCard('c1'), state)?.[1] ?? '', /^No agent left: fix-login retired/);
    assert.deepEqual(lines, ['card c1: left to the person, because fix-login retired and no ancestor of claude:kid is alive']);
    // The log read again from the start finds the card already with the person.
    fs.rmSync(h.cursor);
    assert.deepEqual(await once(t, h), []);
    assert.equal(t.inbox.getCard('c1').reassignedFrom?.length, 1);
  });

  it('does nothing when a stream merely goes quiet and comes back', async () => {
    const t = setup();
    const h = home();
    h.parent('root');
    h.child('root', { id: 'k1', name: 'fix-login', session: 'kid' });
    listen(t, 'claude:root');
    t.inbox.postCard(t.agent, { id: 'c1', agent: 'claude:kid', title: 'q' });
    // The child's stream closes and stays closed past the orphan hour, as a laptop lid or a restarted daemon does.
    t.inbox.connect(t.agent, 'claude:kid', () => {})();
    t.clock.advance(ORPHAN_MS + 1);
    assert.deepEqual(await once(t, h), []);
    assert.equal(t.inbox.getCard('c1').agent, 'claude:kid');
    // It comes back: still nothing moved, and the card reads open again.
    t.inbox.connect(t.agent, 'claude:kid', () => {});
    assert.deepEqual(await once(t, h), []);
    const card = t.inbox.getCard('c1');
    assert.equal(card.agent, 'claude:kid');
    assert.equal(card.reassignedFrom, undefined);
    assert.equal(t.inbox.summaryState().states['c1'], 'open');
  });

  it('keeps the trace on a card that moves twice', async () => {
    const t = setup();
    const h = home();
    h.parent('root');
    h.child('root', { id: 'k-lead', name: 'lead', session: 'lead' });
    h.parent('lead', 'k-lead');
    h.child('lead', { id: 'k-kid', name: 'kid', session: 'kid' });
    listen(t, 'claude:root');
    t.inbox.postCard(t.agent, { id: 'c1', agent: 'claude:kid', title: 'q' });
    h.retire('lead', 'k-kid', 'kid');
    await once(t, h);
    h.retire('root', 'k-lead', 'lead');
    await once(t, h);
    assert.deepEqual(t.inbox.getCard('c1').reassignedFrom?.map((r) => [r.from, r.to, r.why]), [
      ['claude:kid', 'claude:lead', 'kid retired'],
      ['claude:lead', 'claude:root', 'lead retired'],
    ]);
  });
});

describe('the identity a card and Bellwether share', () => {
  it('matches on the harness and its session id, with pi recording the session file', () => {
    assert.equal(agentOf('claude-code', 'abc'), 'claude:abc');
    assert.equal(agentOf('pi', 'abc'), 'pi:abc');
    assert.equal(agentOf('opencode', 'abc'), 'opencode:abc');
    assert.equal(agentOf('codex', 'abc'), undefined, 'a harness without an integration posts no cards');
    assert.equal(sessionId({ kind: 'path', value: '/home/x/.pi/agent/sessions/--w--/2026-11-27T08-42-21-442Z_01a21c2b-7b80-752c.jsonl' }), '01a21c2b-7b80-752c');
    assert.equal(sessionId({ kind: 'id', value: '3d595841' }), '3d595841');
  });

  it('takes the running record when two children answer to one session, as after a resume', () => {
    const tree = new Tree([
      { id: 'claude-code-a', harness: 'claude-code', session: 'a', children: [{ id: 'old', name: 'old', harness: 'claude-code', session: { kind: 'id', value: 's' }, startedAt: '2026-11-27T09:00:00Z', exitedAt: '2026-11-27T09:30:00Z' }] },
      { id: 'claude-code-b', harness: 'claude-code', session: 'b', children: [{ id: 'new', name: 'new', harness: 'claude-code', session: { kind: 'id', value: 's' }, startedAt: '2026-11-27T08:00:00Z' }] },
    ]);
    assert.deepEqual(tree.ancestry('claude:s')?.map((l) => l.agent), ['claude:s', 'claude:b']);
    assert.equal(tree.ancestry('claude:unknown'), undefined, 'an agent Bellwether does not know has no chain, and nothing moves');
  });
});

describe('reading retire.log', () => {
  it('reads whole lines only, from where it stopped, and from the start after a rotation', () => {
    const h = home();
    const log = path.join(h.dir, 'retire.log');
    fs.writeFileSync(log, `${JSON.stringify({ at: '1', parent: 'p', child: 'a', name: 'A' })}\n{"child":"b","na`);
    const first = readRetirements(h.dir, undefined);
    assert.deepEqual(first.retirements.map((r) => r.child), ['a']);
    fs.appendFileSync(log, 'me":"B"}\n');
    const second = readRetirements(h.dir, first.cursor);
    assert.deepEqual(second.retirements.map((r) => r.child), ['b']);
    assert.deepEqual(readRetirements(h.dir, second.cursor).retirements, []);
    // Rotation: a new file, shorter than where the reader stopped.
    fs.rmSync(log);
    fs.writeFileSync(log, `${JSON.stringify({ at: '2', parent: 'p', child: 'c', name: 'C' })}\n`);
    assert.deepEqual(readRetirements(h.dir, second.cursor).retirements.map((r) => r.child), ['c']);
  });
});
