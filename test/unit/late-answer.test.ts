// A late answer: the person sends an answer to a card its agent already closed, as retracted or self-answered. The answer
// goes to the agent once, marked late with the close quoted, and the card keeps its close. No approval is typed and no
// widget response is filled, since both were meant for a live answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAnswer } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, cardState, type ApprovalSender } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { agent, owner } from './fixture.ts';

function stub(): ApprovalSender & { sent: [string, string][] } {
  const sent: [string, string][] = [];
  return { sent, send: async (pane, text) => { sent.push([pane, text]); }, describe: async () => ({}) };
}

function setup(sender?: ApprovalSender) {
  let t = 1000;
  const inbox = new Inbox(new MemoryStorage(), () => (t += 10), new MemoryBlobs(), sender ? { approvals: sender } : {});
  const heard: AgentEvent[] = [];
  return { inbox, heard, listen: () => inbox.connect(agent, 's1', (ev) => heard.push(ev)) };
}

const answers = (heard: AgentEvent[]) => heard.filter((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer');

describe('a late answer', () => {
  it('reaches the agent once, marked late with the close it answers, and the card keeps its close', async () => {
    const { inbox, heard, listen } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which size?', options: [{ id: 'o1', label: 'Small' }, { id: 'o2', label: 'Large' }] });
    listen();
    const closed = inbox.close(agent, 'c1', 'retracted', 'Picked Small myself.');
    const saved = await inbox.answer('c1', { values: { choice: 'o2' }, comment: 'Large, please.' });
    assert.deepEqual(saved.late, { kind: 'retracted', outcome: 'Picked Small myself.', at: closed.closed!.at });
    const got = answers(heard);
    assert.equal(got.length, 1, 'delivered once');
    assert.deepEqual(got[0]!.answer.late, saved.late);
    assert.deepEqual(inbox.getCard('c1').closed, closed.closed, 'the close stays as the agent made it');
    assert.equal(cardState(inbox.getCard('c1'), inbox.state().answers['c1']), 'delivered', 'the outbox follows the late answer');
    // A second stream connecting later hears nothing more.
    inbox.connect(agent, 's1', (ev) => heard.push(ev));
    assert.equal(answers(heard).length, 1);
  });

  it('says it is late and quotes the close, at the top of the text the agent reads', async () => {
    const { inbox, heard, listen } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which size?' });
    inbox.close(agent, 'c1', 'self-answered', 'Found it in the README.');
    listen();
    await inbox.answer('c1', { comment: 'The README is out of date.' });
    const ev = answers(heard)[0]!;
    const text = describeAnswer(ev.card, ev.answer);
    const first = text.split('\n')[0]!;
    assert.match(first, /late/i);
    assert.match(first, /already closed this card/);
    assert.match(first, /answered it yourself/);
    assert.match(first, /"Found it in the README\."/);
    assert.match(text, /new card/);
    assert.match(text, /Comment: The README is out of date\./);
  });

  it('waits for an agent that is offline, as any undelivered answer does', async () => {
    const { inbox, heard, listen } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    inbox.close(agent, 'c1', 'retracted', 'Not needed.');
    await inbox.answer('c1', { comment: 'Still worth a look.' });
    assert.equal(cardState(inbox.getCard('c1'), inbox.state().answers['c1']), 'answered');
    listen();
    assert.equal(answers(heard).length, 1);
    assert.equal(answers(heard)[0]!.answer.late?.kind, 'retracted');
  });

  it('fills no widget response, since the response was written for a live answer', async () => {
    const { inbox } = setup();
    inbox.saveWidget('ok', 'root = FormControl("Go", c)\nc = CheckBoxGroup("go", [y])\ny = CheckBoxItem("", "", "yes")', undefined, { response: 'Merge it now.' });
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Merge?', body: 'root = Card([r])\nr = widget ok {}' });
    inbox.close(agent, 'c1', 'retracted', 'Merged by CI.');
    const saved = await inbox.answer('c1', { values: { go: { yes: true } } });
    assert.equal(saved.responses, undefined);
  });

  it('never types an approval, and tells the agent it was not sent', async () => {
    const sender = stub();
    const { inbox, heard, listen } = setup(sender);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Push?', approvals: [{ pane: 'w6P:p2', text: 'Yes, push it.' }] });
    inbox.close(agent, 'c1', 'retracted', 'Pushed already.');
    listen();
    await inbox.answer('c1', { values: { approval_0: true } });
    const after = await inbox.sendApprovals(owner, 'c1');
    assert.deepEqual(sender.sent, [], 'nothing typed into the pane');
    assert.equal(after?.values['approval_0'], undefined, 'the approval is not kept as approved');
    assert.equal(after?.approvalResults, undefined);
    const ev = answers(heard)[0]!;
    assert.match(describeAnswer(ev.card, ev.answer), /Approval 1 for pane w6P:p2, "Yes, push it\.": not sent, because the card was closed/);
  });

  it('is not late after a dismissal, which the agent never heard of', async () => {
    const { inbox } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    inbox.dismiss(owner, 'c1', { comment: 'later' });
    const saved = await inbox.answer('c1', { comment: 'Now I know.' });
    assert.equal(saved.late, undefined);
  });

  it('is not late when the person answered before the close', async () => {
    const { inbox } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'q' });
    const saved = await inbox.answer('c1', { comment: 'Yes.' });
    inbox.close(agent, 'c1', 'resolved', 'Done.');
    assert.equal(saved.late, undefined);
    assert.equal(inbox.state().answers['c1']?.late, undefined);
  });

  it('goes through the HTTP answer route the page uses, and the route keeps approvals unsent', async () => {
    const sender = stub();
    const inbox = new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs(), { approvals: sender });
    const agentToken = (await inbox.createToken('a', 'agent')).secret;
    const ownerToken = (await inbox.createToken('o', 'owner')).secret;
    const handle = createHandler(inbox);
    const call = (path: string, token: string, body: unknown) => handle(new Request(`http://inbox.test${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    assert.equal((await call('/v1/cards', agentToken, { id: 'h1', agent: 's1', title: 'Push?', approvals: [{ pane: 'w6P:p2', text: 'Yes.' }] })).status, 201);
    assert.equal((await call('/v1/cards/h1/close', agentToken, { kind: 'retracted', outcome: 'Not needed.' })).status, 200);
    const res = await call('/v1/cards/h1/answer', ownerToken, { values: { approval_0: true }, comment: 'Sending anyway.' });
    assert.equal(res.status, 200);
    const body = await res.json() as { late?: { kind: string; outcome: string } };
    assert.equal(body.late?.kind, 'retracted');
    assert.equal(body.late?.outcome, 'Not needed.');
    assert.deepEqual(sender.sent, []);
    assert.equal(inbox.getCard('h1').closed?.kind, 'retracted');
  });
});
