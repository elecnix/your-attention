import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { describeAnswer } from '../../src/client.ts';
import { Inbox, type ApprovalSender } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { Answer } from '../../src/core/types.ts';
import { boxState, herdrApprovals } from '../../src/integrations/herdr/approve.ts';
import { agent, owner } from './fixture.ts';

/** A sender that records each send, or fails with `fail` when it is set. */
function stub(fail?: string): ApprovalSender & { sent: [string, string][] } {
  const list: [string, string][] = [];
  return {
    sent: list,
    send: async (pane, text) => { if (fail) throw new Error(fail); list.push([pane, text]); },
    describe: async (pane) => (pane === 'w6P:p2' ? { agent: 'claude', title: 'release', tab: 'login fix', workspace: 'DevEx' } : {}),
  };
}

const approval = { pane: 'w6P:p2', text: 'Yes, push the tag v1.2.0.' };

function inboxWith(sender?: ApprovalSender): Inbox {
  return new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs(), sender ? { approvals: sender } : {});
}

describe('approvals on a card', () => {
  it('takes at most five, each with a herdr pane id and a text of at most 1,000 characters', () => {
    const inbox = inboxWith(stub());
    const post = (approvals: unknown) => () => inbox.postCard(agent, { agent: 's1', title: 'Push?', approvals } as never);
    assert.doesNotThrow(post([approval, { ...approval, label: 'Push the tag' }]));
    assert.throws(post(Array(6).fill(approval)), /at most 5/);
    assert.throws(post([{ ...approval, text: 'x'.repeat(1001) }]), /1,000 characters/);
    assert.throws(post([{ ...approval, text: '  ' }]), /text/);
    assert.throws(post([{ ...approval, text: '-x' }]), /dash/);
    for (const pane of ['w6P', 'w6P:p2; rm -rf', '-w6P:p2', 'p2', '']) assert.throws(post([{ ...approval, pane }]), /herdr pane id/, pane);
    assert.throws(post('w6P:p2'), /list/);
    assert.throws(post([{ ...approval, label: 'x'.repeat(121) }]), /label/);
  });

  it('is refused by an inbox that cannot type into a pane, such as the hosted inbox', () => {
    assert.throws(() => inboxWith().postCard(agent, { agent: 's1', title: 'Push?', approvals: [approval] }), (e: Error & { status?: number }) => e.status === 400 && /approvals/.test(e.message));
  });

  it('is refused on a card that is not an ask card', () => {
    const inbox = inboxWith(stub());
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Blocked', kind: 'blocked', approvals: [approval] }), /approvals/);
  });

  it('names the pane\'s agent and tab, which the inbox looks up and an agent cannot set', async () => {
    const inbox = inboxWith(stub());
    const card = await inbox.postCardWithFiles(agent, { agent: 's1', title: 'Push?', approvals: [{ ...approval, place: { tab: 'forged' } }, { pane: 'w9:p1', text: 'Go.' }] } as never);
    assert.deepEqual(card.approvals, [{ ...approval, place: { agent: 'claude', title: 'release', tab: 'login fix', workspace: 'DevEx' } }, { pane: 'w9:p1', text: 'Go.' }]);
  });

  it('keeps that place when the agent revises the card, and drops it for a pane it changes', async () => {
    const inbox = inboxWith(stub());
    const card = await inbox.postCardWithFiles(agent, { agent: 's1', title: 'Push?', text: 'The release is tagged.', approvals: [approval] } as never);
    const revised = await inbox.patchCardChecked(agent, card.id, [{ old: 'tagged', new: 'built' }]);
    assert.deepEqual(revised.approvals?.[0]?.place, { agent: 'claude', title: 'release', tab: 'login fix', workspace: 'DevEx' });
    // A repost that moves the approval to another pane carries no place, because herdr has not answered for that pane.
    const moved = await inbox.postCard(agent, { id: card.id, agent: 's1', title: 'Push?', text: 'The release is built.', approvals: [{ pane: 'w9:p1', text: 'Yes, push it.' }] } as never);
    assert.deepEqual(moved.approvals, [{ pane: 'w9:p1', text: 'Yes, push it.' }]);
  });
});

describe('the send rule', () => {
  async function answered(sender: ApprovalSender, values: Record<string, unknown>, caller = owner): Promise<{ inbox: Inbox; answer: Answer | undefined }> {
    const inbox = inboxWith(sender);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Push?', approvals: [approval, { pane: 'w7:p3', text: 'Yes, delete the branch.' }] });
    await inbox.answer('c1', { values });
    return { inbox, answer: await inbox.sendApprovals(caller, 'c1') };
  }

  it('sends each approval the owner turned on, and records when', async () => {
    const s = stub();
    const { answer } = await answered(s, { approval_0: true, approval_1: false });
    assert.deepEqual(s.sent, [['w6P:p2', 'Yes, push the tag v1.2.0.']]);
    assert.equal(typeof (answer?.approvalResults?.[0] as { sentAt: number }).sentAt, 'number');
    assert.equal(answer?.approvalResults?.[1], null);
  });

  it('tells the agent a send only when one was recorded', () => {
    const card = { id: 'c1', agent: 's1', title: 'Push?', approvals: [approval] } as never;
    const said = (a: Record<string, unknown>) => describeAnswer(card, a as never);
    assert.match(said({ values: { approval_0: true }, approvalResults: [{ sentAt: 1793760000000 }] }), /typed it into the pane/);
    assert.match(said({ values: { approval_0: true }, approvalResults: [{ error: 'the input box holds a draft' }] }), /but not sent: the input box holds a draft/);
    assert.match(said({ values: { approval_0: true } }), /recorded no send/);
    assert.match(said({ values: { approval_0: false } }), /not approved/);
  });

  it('sends nothing for an approval that is off', async () => {
    const s = stub();
    const { answer } = await answered(s, { approval_0: false, approval_1: false });
    assert.deepEqual(s.sent, []);
    assert.equal(answer?.approvalResults, undefined);
  });

  it('never sends for an agent\'s token', async () => {
    const s = stub();
    const { inbox } = await answered(s, { approval_0: true }, agent);
    assert.deepEqual(s.sent, []);
    assert.equal(inbox.cardDetail('c1').answer?.approvalResults, undefined);
  });

  it('records the error when herdr refuses, and sends on the next answer', async () => {
    const failing = stub('the input box in w6P:p2 holds a draft');
    const { answer } = await answered(failing, { approval_0: true });
    assert.deepEqual(answer?.approvalResults?.[0], { error: 'the input box in w6P:p2 holds a draft' });
    assert.deepEqual(failing.sent, []);
  });

  it('never sends twice for the same card version, and sends again after a revision', async () => {
    const s = stub();
    const { inbox } = await answered(s, { approval_0: true });
    await inbox.answer('c1', { values: { approval_0: true }, comment: 'again' });
    const again = await inbox.sendApprovals(owner, 'c1');
    assert.equal(s.sent.length, 1);
    assert.ok(again?.approvalResults?.[0] && 'sentAt' in again.approvalResults[0]);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Push?', approvals: [approval] });
    await inbox.answer('c1', { values: { approval_0: true } });
    await inbox.sendApprovals(owner, 'c1');
    assert.equal(s.sent.length, 2);
  });

  it('sends nothing when the answer is for an older version of the card', async () => {
    const s = stub();
    const inbox = inboxWith(s);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Push?', approvals: [approval] });
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Push?', approvals: [{ ...approval, text: 'Yes, push v2.' }] });
    await inbox.answer('c1', { values: { approval_0: true }, version: 1 });
    const answer = await inbox.sendApprovals(owner, 'c1');
    assert.deepEqual(s.sent, []);
    assert.match((answer?.approvalResults?.[0] as { error: string }).error, /changed/);
  });

  it('sends when the owner answers over HTTP, and an agent cannot answer at all', async () => {
    const s = stub();
    const inbox = inboxWith(s);
    const handle = createHandler(inbox);
    const ownerToken = (await inbox.createToken('page', 'owner')).secret;
    const agentToken = (await inbox.createToken('agents', 'agent')).secret;
    const call = (path: string, token: string, body: unknown) => handle(new Request(`http://inbox.test${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    assert.equal((await call('/v1/cards', agentToken, { id: 'h1', agent: 's1', title: 'Push?', approvals: [approval] })).status, 201);
    assert.equal((await call('/v1/cards/h1/answer', agentToken, { values: { approval_0: true } })).status, 403);
    assert.deepEqual(s.sent, []);
    const res = await call('/v1/cards/h1/answer', ownerToken, { values: { approval_0: true } });
    assert.equal(res.status, 200);
    assert.ok('sentAt' in (((await res.json()) as Answer).approvalResults?.[0] ?? {}));
    assert.deepEqual(s.sent, [['w6P:p2', 'Yes, push the tag v1.2.0.']]);
  });
});

describe('typing an approval into a herdr pane', () => {
  const SCREEN = (box: string) => `\x1b[38;2;136;136;136m──────\x1b[0m\r\n❯ earlier message\r\n  done.\r\n\x1b[38;2;136;136;136m──────\r\n❯ ${box}\r\n──────\r\n  ⏵⏵ auto mode on`;
  function herdr(screen: string, calls: string[][], panes = ['w6P:p2']) {
    return async (...args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === 'pane' && args[1] === 'get') {
        if (!panes.includes(args[2] ?? '')) throw new Error('pane not found');
        return JSON.stringify({ result: { pane: { pane_id: args[2], agent: 'claude', terminal_title_stripped: 'release', tab_id: 'w6P:t2', workspace_id: 'w6P' } } });
      }
      if (args[0] === 'pane' && args[1] === 'read') return screen;
      if (args[0] === 'tab') return JSON.stringify({ result: { tab: { label: 'login fix' } } });
      if (args[0] === 'workspace') return JSON.stringify({ result: { workspace: { label: 'DevEx' } } });
      return '{}';
    };
  }

  it('reads an empty box, a dim suggestion, and a draft the person typed', () => {
    assert.equal(boxState(SCREEN('')).state, 'EMPTY');
    assert.equal(boxState(SCREEN('\x1b[2mtry "fix the tests"\x1b[0m')).state, 'GHOST');
    assert.equal(boxState(SCREEN('\x1b[2;38;5;8mtry this\x1b[0m')).state, 'GHOST');
    assert.equal(boxState(SCREEN('wait, do not push')).state, 'DRAFT');
    // 38;2;r;g;b is a color, not the faint attribute.
    assert.equal(boxState(SCREEN('\x1b[38;2;2;2;2mmine\x1b[0m')).state, 'DRAFT');
    assert.equal(boxState('no box here').state, 'NO-BOX');
  });

  it('checks the pane, reads its box, then submits the text as the person\'s message', async () => {
    const calls: string[][] = [];
    await herdrApprovals(herdr(SCREEN('\x1b[2msuggestion\x1b[0m'), calls)).send('w6P:p2', 'Yes, push the tag.');
    assert.deepEqual(calls, [
      ['pane', 'get', 'w6P:p2'],
      ['pane', 'read', 'w6P:p2', '--lines', '40', '--source', 'visible', '--format', 'ansi'],
      ['agent', 'prompt', 'w6P:p2', 'Yes, push the tag.'],
    ]);
  });

  it('sends nothing over the person\'s draft, to a pane herdr does not know, or without an input box', async () => {
    for (const [screen, panes, error] of [
      [SCREEN('wait, do not push'), ['w6P:p2'], /draft/],
      [SCREEN(''), [], /no pane w6P:p2/],
      ['a shell prompt $', ['w6P:p2'], /input box/],
    ] as const) {
      const calls: string[][] = [];
      await assert.rejects(herdrApprovals(herdr(screen, calls, [...panes])).send('w6P:p2', 'Yes.'), error);
      assert.ok(!calls.some((c) => c[0] === 'agent'), String(error));
    }
  });

  it('names the agent, session, tab and workspace of a pane, and nothing when herdr fails', async () => {
    const approvals = herdrApprovals(herdr('', []));
    assert.deepEqual(await approvals.describe?.('w6P:p2'), { agent: 'claude', title: 'release', tab: 'login fix', workspace: 'DevEx' });
    assert.deepEqual(await approvals.describe?.('w9:p9'), {});
  });
});
