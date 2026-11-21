// A guidance proposal edits the guidance the way card_patch edits a card: each edit replaces a passage that occurs once.
// The card keeps the edits, so two proposals from the same version both apply, and an edit whose passage is gone by the
// approval closes the card instead of overwriting the guidance. A whole new text goes only under replace_all_with.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { agentName } from '../../web/queue.js';
import { setup } from './fixture.ts';

const BASE = 'Lead with the goal.\nGive two options.\nEnd with a recommendation.';
const HERE = { harness: 'claude-code', session: 'abc', name: 'guidance-fixer', host: 'laptop', cwd: '/src/app', herdrPane: 'w1:p2', herdrWorkspace: 'app', herdrTab: 'fixes' };

function seeded() {
  const s = setup();
  // Every test starts from the same three rules, stored as version 7.
  (s.inbox as unknown as { store: MemoryStorage }).store.put('meta', 'guidance', { text: BASE, version: 7, at: 0 });
  return s;
}

const refused = (status: number, message: RegExp) => (e: unknown): boolean => e instanceof InboxError && e.status === status && message.test(e.message);

describe('guidance proposals as edits', () => {
  it('stores the edits, and derives the proposed text from the guidance on each read', () => {
    const { inbox, agent } = seeded();
    const card = inbox.proposeGuidance([{ old: 'Give two options.', new: 'Give three options.' }], 'Two was too few.', { caller: agent, agent: 's1' });
    assert.deepEqual(card.broadcast?.edits, [{ old: 'Give two options.', new: 'Give three options.' }]);
    assert.equal(card.broadcast?.text, undefined, 'the card stores the edits, not a whole text');
    const shown = inbox.cardDetail(card.id, true).card.broadcast;
    assert.equal(shown?.text, 'Lead with the goal.\nGive three options.\nEnd with a recommendation.');
    assert.deepEqual(shown?.base, { version: 7, text: BASE }, 'the diff is against the guidance as it is now');
    assert.equal(inbox.state().cards.find((c) => c.id === card.id)?.broadcast?.text, shown?.text, 'the page state reads the same text');
  });

  it('applies two additions proposed from the same version, in either order', async () => {
    for (const order of [[0, 1], [1, 0]] as const) {
      const { inbox, agent } = seeded();
      const cards = [
        inbox.proposeGuidance([{ old: 'Lead with the goal.', new: 'Lead with the goal.\nName the repository.' }], 'Adds the repository rule.', { caller: agent, agent: 's1' }),
        inbox.proposeGuidance([{ old: 'End with a recommendation.', new: 'End with a recommendation.\nAttach a screenshot.' }], 'Adds the screenshot rule.', { caller: agent, agent: 's2' }),
      ];
      const rev = inbox.cardDetail(cards[order[1]]!.id, true).rev;
      await inbox.answer(cards[order[0]]!.id, { values: { choice: 'approve' } });
      // The second card now shows its edit on the newer guidance, so approving it keeps the first one's line.
      assert.equal(inbox.cardDetail(cards[order[1]]!.id, true).card.broadcast?.base?.version, 8);
      assert.notEqual(inbox.cardDetail(cards[order[1]]!.id, true).rev, rev, 'a page that holds the other card fetches it again');
      await inbox.answer(cards[order[1]]!.id, { values: { choice: 'approve' } });
      assert.equal(inbox.guidance().text, 'Lead with the goal.\nName the repository.\nGive two options.\nEnd with a recommendation.\nAttach a screenshot.');
      assert.equal(inbox.guidance().version, 9);
    }
  });

  it('closes a proposal whose passage is gone by the approval, tells its agent, and leaves the guidance alone', async () => {
    const { inbox, agent } = seeded();
    const heard: AgentEvent[] = [];
    inbox.connect(agent, 's2', (e) => heard.push(e));
    const first = inbox.proposeGuidance([{ old: 'Give two options.', new: 'Give three options.' }], 'Two was too few.', { caller: agent, agent: 's1' });
    const second = inbox.proposeGuidance([{ old: 'Give two options.', new: 'Give two options, with costs.' }], 'Costs help.', { caller: agent, agent: 's2' });
    await inbox.answer(first.id, { values: { choice: 'approve' } });
    const stale = inbox.cardDetail(second.id, true).card.broadcast;
    assert.match(String(stale?.stale), /edit 1/, 'the page can say before the approval that the edit no longer applies');
    assert.equal(stale?.text, inbox.guidance().text, 'a stale proposal shows no change');
    await inbox.answer(second.id, { values: { choice: 'approve' } });
    assert.equal(inbox.guidance().text, 'Lead with the goal.\nGive three options.\nEnd with a recommendation.');
    assert.equal(inbox.guidance().version, 8, 'the stale approval made no version');
    const closed = inbox.getCard(second.id).closed;
    assert.equal(closed?.kind, 'resolved');
    assert.match(String(closed?.outcome), /^Not applied: edit 1/);
    const ev = heard.find((e) => e.type === 'answer');
    assert.ok(ev && ev.type === 'answer', 'the proposing agent receives the answer');
    assert.match(String(ev.card.closed?.outcome), /^Not applied: edit 1/);
  });

  it('refuses at proposal an old text that is missing or repeated, naming the edit', () => {
    const { inbox, agent } = seeded();
    const by = { caller: agent, agent: 's1' };
    assert.throws(() => inbox.proposeGuidance([{ old: 'Lead with the goal.', new: 'Lead with the goal first.' }, { old: 'Give four options.', new: 'Give five.' }], 'Why.', by), refused(409, /^edit 2: the old text occurs 0 times in guidance version 7/));
    (inbox as unknown as { store: MemoryStorage }).store.put('meta', 'guidance', { text: `${BASE}\nGive two options.`, version: 8, at: 0 });
    assert.throws(() => inbox.proposeGuidance([{ old: 'Give two options.', new: 'Give three.' }], 'Why.', by), refused(409, /^edit 1: the old text occurs 2 times/));
    assert.throws(() => inbox.proposeGuidance([], 'Why.', by), refused(400, /edits/));
    assert.throws(() => inbox.proposeGuidance([{ old: '', new: 'x' }], 'Why.', by), refused(400, /edit 1: old/));
    assert.throws(() => inbox.proposeGuidance([{ old: 'Lead with the goal.', new: 'Lead with the goal.' }], 'Why.', by), refused(400, /edit 1: new is identical/));
    assert.throws(() => inbox.proposeGuidance([{ old: `${BASE}\nGive two options.`, new: '' }], 'Why.', by), refused(400, /empty/), 'edits that delete every rule are refused');
  });

  it('records where the proposing agent runs, and the page names that agent rather than the system', () => {
    const { inbox, agent } = seeded();
    const card = inbox.proposeGuidance([{ old: 'Give two options.', new: 'Give three options.' }], 'Two was too few.', { caller: agent, agent: 's1', origin: HERE });
    assert.equal(card.agent, 'system', 'the card stays a system card the owner approves');
    assert.equal(card.proposedBy, 's1');
    assert.deepEqual(card.origin, HERE);
    const state = inbox.summaryState();
    assert.equal(state.cards.find((c) => c.id === card.id)?.proposedBy, 's1');
    assert.equal(agentName('system', state.cards, state.presence), 'system', 'the system keeps its own name');
    assert.equal(agentName('s1', state.cards, state.presence), 'guidance-fixer', 'the proposer is named from the card it caused');
  });

  it('takes the origin from the proposing agent\'s connection when the proposal carries none', () => {
    const { inbox, agent } = seeded();
    inbox.connect(agent, 's1', () => {}, undefined, { origin: { harness: 'pi', name: 'fixer', host: 'laptop', herdrPane: 'w3:p1' } });
    const card = inbox.proposeGuidance([{ old: 'Give two options.', new: 'Give three options.' }], 'Two was too few.', { caller: agent, agent: 's1' });
    assert.deepEqual(card.origin, { harness: 'pi', name: 'fixer', host: 'laptop', herdrPane: 'w3:p1' });
  });

  it('names the agent behind the other system cards an agent causes', () => {
    const { inbox, agent } = seeded();
    const rule = inbox.proposeRequireCard({ on: true, by: { caller: agent, agent: 's1', origin: HERE } });
    assert.equal(rule.proposedBy, 's1');
    assert.deepEqual(rule.origin, HERE);
    const sub = inbox.subscribe(agent, { agent: 'cli:deploy', kind: 'system', title: 'Subscribe', origin: HERE, system: { type: 'subscribe', webhook: { url: 'https://example.com/hook' }, events: ['answer'] } });
    assert.equal(sub.card.proposedBy, 'cli:deploy');
    assert.deepEqual(sub.card.origin, HERE);
  });
});

describe('POST /v1/guidance and card_guidance', () => {
  const HOST = 'guidance-edits.test';
  let served: ReturnType<typeof createHandler> | undefined;
  // The unit tests share one process, so this stand-in wraps whatever fetch another file installed, and puts it back.
  let previous: typeof fetch = globalThis.fetch;
  before(() => {
    previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (new URL(req.url).host !== HOST || !served) return previous(input, init);
      return served(req);
    }) as typeof fetch;
  });
  after(() => { globalThis.fetch = previous; });

  async function serve() {
    const storage = new MemoryStorage();
    storage.put('meta', 'guidance', { text: BASE, version: 7, at: 0 });
    const inbox = new Inbox(storage, () => 1_000);
    served = createHandler(inbox, { heartbeatMs: 50 });
    const secret = (await inbox.createToken('agents', 'agent')).secret;
    const post = (body: unknown) => served!(new Request(`http://${HOST}/v1/guidance`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const tool = (args: Record<string, unknown>) => runTool({ inbox: new Client({ url: `http://${HOST}`, token: secret }), secrets: {} as never, agent: 's1', origin: async () => HERE, arrival: 'as a test' }, 'card_guidance', args);
    const owner: Caller = { token: 'to', role: 'owner' };
    return { inbox, post, tool, owner };
  }

  it('takes edits, and refuses a missing old text with the reason', async () => {
    const { inbox, post } = await serve();
    const ok = await post({ edits: [{ old: 'Give two options.', new: 'Give three options.' }], message: 'Two was too few.', agent: 's1', origin: HERE });
    assert.equal(ok.status, 201);
    const card = (await ok.json()) as { id: string; proposedBy?: string; origin?: unknown };
    assert.equal(card.proposedBy, 's1');
    assert.deepEqual(card.origin, HERE);
    assert.equal(inbox.cardDetail(card.id, true).card.broadcast?.text, 'Lead with the goal.\nGive three options.\nEnd with a recommendation.');
    const missing = await post({ edits: [{ old: 'Give four options.', new: 'x' }], message: 'Why.', agent: 's1' });
    assert.equal(missing.status, 409);
    assert.match(((await missing.json()) as { error: string }).error, /^edit 1: the old text occurs 0 times/);
    const both = await post({ edits: [{ old: 'Give two options.', new: 'x' }], replace_all_with: 'Everything.', message: 'Why.', agent: 's1' });
    assert.equal(both.status, 400, 'a proposal is edits or a whole text, never both');
  });

  it('replaces the whole text only under replace_all_with, and text stays its alias', async () => {
    const { inbox, post } = await serve();
    for (const body of [{ replace_all_with: 'Only this rule.' }, { text: 'Only this rule.' }]) {
      const res = await post({ ...body, message: 'Start over.', agent: 's1' });
      assert.equal(res.status, 201);
      const id = ((await res.json()) as { id: string }).id;
      assert.equal(inbox.cardDetail(id, true).card.broadcast?.text, 'Only this rule.');
      await inbox.answer(id, { values: { choice: 'approve' } });
      assert.equal(inbox.guidance().text, 'Only this rule.');
    }
  });

  it('proposes edits from the tool, and keeps propose as a deprecated alias of replace_all_with', async () => {
    const { inbox, tool } = await serve();
    const edited = await tool({ edits: [{ old: 'Give two options.', new: 'Give three options.' }], message: 'Two was too few.' });
    assert.match(edited, /^Proposed 1 edit to guidance version 7 on card guidance-/);
    const id = /card (guidance-\w+)/.exec(edited)![1]!;
    assert.deepEqual(inbox.getCard(id).origin, HERE, 'the tool sends where the session runs');
    assert.equal(inbox.getCard(id).proposedBy, 's1');
    const replaced = await tool({ replace_all_with: 'Only this rule.', message: 'Start over.' });
    assert.match(replaced, /replaces every rule/);
    const alias = await tool({ propose: 'Only this rule.', message: 'Start over.' });
    assert.match(alias, /propose is deprecated/);
    const aliasId = /card (guidance-\w+)/.exec(alias)![1]!;
    assert.equal(inbox.cardDetail(aliasId, true).card.broadcast?.text, 'Only this rule.');
    await assert.rejects(tool({ edits: [{ old: 'Give two options.', new: 'x' }], replace_all_with: 'All.', message: 'Why.' }), /either edits or replace_all_with/);
  });
});
