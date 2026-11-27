// The privileged_action widget on the inbox side: the card that shows a command, the broker key the page seals a
// password to, the run inside the owner's answer, the refusal of a command that differs from the card's, and the
// audit. SPEC.md#privileged-actions holds the contract. A recording runner stands in for the laptop's broker.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAnswer } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { commandDifference, dryRunner, maskPassword, PASSWORD_MASK, type PrivilegedRun, type PrivilegedRunner } from '../../src/core/privileged.ts';
import { privilegedActions, sealValue } from '../../src/core/sealed.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';

const PASSWORD = 'FIXTURE-PASSWORD-DO-NOT-USE';
const MACHINE = 'test-machine';
const COMMAND = 'touch /tmp/ya-fixture-marker';
const agent: Caller = { token: 'ta', role: 'agent' };
const NOW = 1_800_000_000_000;

const body = (command = COMMAND, machine = MACHINE) =>
  `root = Card([run])\nrun = widget privileged_action ${JSON.stringify({ name: 'run_it', command, machine, changes: 'Creates a marker file' })}`;

/** A runner that records each call, prints the password back the way a careless command would, and runs nothing. */
function recording(): PrivilegedRunner & { calls: { command: string; password: string }[] } {
  const calls: { command: string; password: string }[] = [];
  return { machine: MACHINE, calls, run: async (command, password) => { calls.push({ command, password }); return { exitCode: 0, output: `checked ${password}\nran ${command}\n` }; } };
}

async function setup(runner: PrivilegedRunner | undefined = recording()) {
  const inbox = new Inbox(new MemoryStorage(), () => NOW, undefined, { privileged: runner });
  const { token, secret } = await inbox.createToken('page on the test machine', 'owner');
  const owner: Caller = { token: token.id, role: 'owner' };
  return { inbox, owner, ownerSecret: secret, runner };
}

/** Seal a password as the page does: the command it showed and the password, as JSON, to the broker's key. */
async function sealFor(inbox: Inbox, owner: Caller, command = COMMAND, password = PASSWORD) {
  const { publicKey } = await inbox.privilegedKey(owner);
  return sealValue(publicKey, JSON.stringify({ command, password }));
}

const rejects = (status: number, message: RegExp) => (e: unknown) => e instanceof InboxError && e.status === status && message.test(e.message);

describe('the privileged_action widget', () => {
  it('places a PrivilegedAction with the command, the machine and what it changes, and the card lists its field', async () => {
    const { inbox } = await setup();
    const card = inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    assert.deepEqual(card.privileged, ['run_it']);
    assert.equal(card.secrets, undefined, 'a privileged action is no secret the agent opens');
    assert.deepEqual(privilegedActions(card.body ?? ''), [{ name: 'run_it', command: COMMAND, machine: MACHINE, changes: 'Creates a marker file' }]);
  });

  it('refuses a card on an inbox without a broker, and a machine the broker does not serve', async () => {
    const none = new Inbox(new MemoryStorage(), () => NOW);
    assert.throws(() => none.postCard(agent, { agent: 's1', title: 'Run?', body: body() }), rejects(400, /runs no privileged actions/));
    const { inbox } = await setup();
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Run?', body: body(COMMAND, 'prod-db') }), rejects(400, /runs commands on test-machine only, not on prod-db/));
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Run?', body: 'root = Card([f])\nf = FormControl("x", PrivilegedAction("x", "ls"))' }), rejects(400, /four string literals/));
  });

  it('answers the broker key to the owner only', async () => {
    const { inbox, owner } = await setup();
    const key = await inbox.privilegedKey(owner);
    assert.equal(key.machine, MACHINE);
    assert.equal(key.publicKey.kty, 'RSA');
    assert.ok(!('d' in key.publicKey), 'only the public half leaves the broker');
    await assert.rejects(inbox.privilegedKey(agent), rejects(403, /only the owner/));
    await assert.rejects(new Inbox(new MemoryStorage()).privilegedKey(owner), rejects(404, /no privileged actions/));
  });
});

describe('a privileged action runs inside the owner answer', () => {
  it('runs the command once with the password, and keeps only the output with the password masked', async () => {
    const { inbox, owner, runner } = await setup();
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    const answer = await inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner });
    const rec = runner as ReturnType<typeof recording>;
    assert.deepEqual(rec.calls, [{ command: COMMAND, password: PASSWORD }]);
    const run = answer.values['run_it'] as PrivilegedRun;
    assert.equal(run.command, COMMAND);
    assert.equal(run.machine, MACHINE);
    assert.equal(run.exitCode, 0);
    assert.equal(run.output, `checked ${PASSWORD_MASK}\nran ${COMMAND}\n`);
  });

  it('keeps the password out of the answer, the card, the stored state and the agent stream', async () => {
    const { inbox, owner } = await setup();
    const events: AgentEvent[] = [];
    inbox.connect(agent, 's1', (ev) => events.push(ev));
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    await inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner });
    const everything = JSON.stringify({ events, state: inbox.state(), card: inbox.cardDetail('p1', true), audit: inbox.privilegedAudit(owner) });
    assert.ok(everything.includes(COMMAND), 'the check reads the stored data');
    assert.ok(!everything.includes(PASSWORD), 'no stored or sent data holds the password');
    assert.ok(events.some((e) => e.type === 'answer'), 'the agent heard the answer');
  });

  it('gives the session no grant, so no command the agent runs gets the password in its environment', async () => {
    const { inbox, owner } = await setup();
    const card = inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    const answer = await inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner });
    const session = new SecretRequests(() => NOW);
    const received = await session.receiveDetail(card, answer);
    assert.deepEqual(received.granted, []);
    assert.ok(!JSON.stringify(session.env('s1')).includes(PASSWORD));
  });

  it('refuses a command that differs from the card by one character, says where, and runs nothing', async () => {
    const { inbox, owner, runner } = await setup();
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    const other = `${COMMAND.slice(0, -1)}X`;
    await assert.rejects(
      inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner, other) }, by: owner }),
      rejects(409, new RegExp(`nothing ran, because the approved command differs from the card's at character ${COMMAND.length}: the card has "r" and the approval has "X"`)),
    );
    assert.deepEqual((runner as ReturnType<typeof recording>).calls, []);
    assert.equal(inbox.cardDetail('p1', true).answer, undefined, 'a refused answer stores nothing');
  });

  it('refuses a command the agent changed after the page sealed the password', async () => {
    const { inbox, owner, runner } = await setup();
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    const sealed = await sealFor(inbox, owner);
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body(`${COMMAND}; rm -rf ~`) });
    await assert.rejects(inbox.answer('p1', { values: { run_it: sealed }, by: owner }), rejects(409, /the card has "; rm -rf ~"|the card has ";"/));
    assert.deepEqual((runner as ReturnType<typeof recording>).calls, []);
  });

  it('takes no plain password, and runs nothing for an empty one', async () => {
    const { inbox, owner, runner } = await setup();
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    await assert.rejects(inbox.answer('p1', { values: { run_it: PASSWORD }, by: owner }), rejects(400, /only a password sealed to the broker's key/));
    const answer = await inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner, COMMAND, '') }, comment: 'not now', by: owner });
    assert.equal(answer.values['run_it'], undefined);
    assert.deepEqual((runner as ReturnType<typeof recording>).calls, []);
  });

  it('runs a command once, and a later answer keeps the record of the run', async () => {
    const { inbox, owner, runner } = await setup();
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    await inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner });
    await assert.rejects(inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner }), rejects(409, /already ran once/));
    const later = await inbox.answer('p1', { values: {}, comment: 'thanks', by: owner });
    assert.equal((later.values['run_it'] as PrivilegedRun).command, COMMAND);
    assert.equal((runner as ReturnType<typeof recording>).calls.length, 1);
  });

  it('runs a command once when two answers arrive at the same moment', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const slow: PrivilegedRunner = { machine: MACHINE, run: async (command) => { calls.push(command); await gate; return { exitCode: 0, output: 'done\n' }; } };
    const { inbox, owner } = await setup(slow);
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    const [a, b] = [await sealFor(inbox, owner), await sealFor(inbox, owner)];
    // Either answer may claim the run first: the other gets 409, before its run starts.
    const both = Promise.allSettled([inbox.answer('p1', { values: { run_it: a }, by: owner }), inbox.answer('p1', { values: { run_it: b }, by: owner })]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const settled = await both;
    assert.equal(settled.filter((x) => x.status === 'fulfilled').length, 1);
    const refused = settled.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejects(409, /already running or ran once/)(refused.reason));
    assert.equal(calls.length, 1);
    assert.equal(inbox.privilegedAudit(owner).length, 1);
  });

  it('runs nothing on a card its agent closed', async () => {
    const { inbox, owner, runner } = await setup();
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    inbox.close(agent, 'p1', 'retracted', 'Not needed.');
    await assert.rejects(inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner }), rejects(409, /agent closed this card/));
    assert.deepEqual((runner as ReturnType<typeof recording>).calls, []);
  });

  it('says a password sealed before a restart no longer opens', async () => {
    const { inbox, owner } = await setup();
    const sealed = await sealFor(inbox, owner);
    // A new inbox on the same storage is a restart: it makes a new broker key.
    const restarted = new Inbox(new MemoryStorage(), () => NOW, undefined, { privileged: recording() });
    restarted.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    await assert.rejects(restarted.answer('p1', { values: { run_it: sealed }, by: owner }), rejects(409, /restarted after the page sealed it/));
  });
});

describe('the audit of privileged actions', () => {
  it('names who approved which command on which machine, and only the owner reads it', async () => {
    const { inbox, owner } = await setup();
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    const answer = await inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner });
    const [entry, ...rest] = inbox.privilegedAudit(owner);
    assert.equal(rest.length, 0);
    assert.deepEqual({ ...entry }, { id: (answer.values['run_it'] as PrivilegedRun).audit, card: 'p1', field: 'run_it', agent: 's1', command: COMMAND, machine: MACHINE, approvedBy: 'page on the test machine', at: NOW, exitCode: 0 });
    assert.throws(() => inbox.privilegedAudit(agent), rejects(403, /only the owner/));
  });

  it('serves the key and the audit to the owner over HTTP, and 403 to an agent', async () => {
    const { inbox, ownerSecret } = await setup(dryRunner(MACHINE));
    const agentSecret = (await inbox.createToken('agent', 'agent')).secret;
    const handle = createHandler(inbox, {});
    const get = (route: string, token: string) => handle(new Request(`http://inbox${route}`, { headers: { authorization: `Bearer ${token}` } }));
    assert.equal((await get('/v1/privileged/key', ownerSecret)).status, 200);
    assert.equal((await get('/v1/privileged/audit', ownerSecret)).status, 200);
    assert.equal((await get('/v1/privileged/key', agentSecret)).status, 403);
    assert.equal((await get('/v1/privileged/audit', agentSecret)).status, 403);
  });
});

describe('the answer text of a privileged action', () => {
  it('says where the command ran, how it ended and what it printed, or that it did not run', async () => {
    const { inbox, owner } = await setup();
    const card = inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Create the marker?', body: body() });
    assert.match(describeAnswer(card, await inbox.answer('p1', { values: {}, by: owner })), /run_it: not run, because the person sent no password/);
    const text = describeAnswer(card, await inbox.answer('p1', { values: { run_it: await sealFor(inbox, owner) }, by: owner }));
    assert.match(text, /run_it: ran on test-machine, exit code 0 \(audit \w+\)\. The command printed:\n```\nchecked \[password\]\nran touch/);
    assert.ok(!text.includes(PASSWORD));
  });
});

describe('the helpers of privileged actions', () => {
  it('names the first character that differs, or the end of the shorter command', () => {
    assert.equal(commandDifference('ls -l', 'ls -l'), undefined);
    assert.match(commandDifference('ls -l', 'ls -L') ?? '', /character 5: the card has "l" and the approval has "L"/);
    assert.match(commandDifference('ls', 'ls -l') ?? '', /character 3: the card has the end of the command and the approval has " "/);
  });

  it('masks every occurrence of the password, and masks nothing for an empty one', () => {
    assert.equal(maskPassword(`a ${PASSWORD} b ${PASSWORD}`, PASSWORD), `a ${PASSWORD_MASK} b ${PASSWORD_MASK}`);
    assert.equal(maskPassword('abc', ''), 'abc');
  });
});
