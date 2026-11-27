// A privileged action end to end on the laptop server, with test/fixtures/pseudo-sudo.mjs standing in for sudo: the
// agent posts the card with card_post, the owner seals the fixture password to the broker's key as the page does, the
// inbox runs the command with the password on its standard input, and the agent gets only what it printed. Each of the
// four places the agent could read the password is searched for it: the card's reply, the session's environment, the
// files under the inbox's home, and what the command printed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, describeAnswer } from '../../src/client.ts';
import { PASSWORD_MASK, type PrivilegedRun } from '../../src/core/privileged.ts';
import type { Card } from '../../src/core/types.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { localRunner } from '../../src/node/privileged.ts';
import { seal } from '../../web/sealed.js';
import { filesHolding, ROOT, start, until, type Harness } from './harness.ts';

const PASSWORD = 'FIXTURE-PASSWORD-DO-NOT-USE';
const MACHINE = 'test-machine';
const PSEUDO = path.join(ROOT, 'test', 'fixtures', 'pseudo-sudo.mjs');

let h: Harness;
let work: string;
before(async () => {
  h = await start({ privileged: localRunner(MACHINE) });
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-privileged-'));
});
after(async () => {
  await h.stop();
  fs.rmSync(work, { recursive: true, force: true });
});

/** The command the card shows: the stand-in checks the password, then creates a marker file. */
const commandFor = (marker: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(PSEUDO)} --expect-sha256 ${createHash('sha256').update(PASSWORD).digest('hex')} -- ${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`;

const placement = (name: string, command: string) => `root = Card([run])\nrun = widget privileged_action ${JSON.stringify({ name, command, machine: MACHINE, changes: 'Creates a marker file in a temporary folder' })}`;

/** Seal as the page does: the command it showed and the password, to the key GET /v1/privileged/key answers. */
async function sealAsPage(command: string): Promise<unknown> {
  const key = await (await h.owner('GET', '/v1/privileged/key')).json() as { publicKey: JsonWebKey; machine: string };
  assert.equal(key.machine, MACHINE);
  return seal(key.publicKey, JSON.stringify({ command, password: PASSWORD }));
}

describe('a privileged action on the laptop server', () => {
  it('runs the approved command with the password, and the agent never sees the password', async () => {
    const marker = path.join(work, 'marker');
    const command = commandFor(marker);
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const listener = h.listen(client, 'pa-1');
    await until(async () => (await h.stored()).presence['pa-1']?.online);
    const secrets = new SecretRequests();
    const ctx = { inbox: client, secrets, agent: 'pa-1', origin: async () => undefined, arrival: 'later' };
    assert.match(await runTool(ctx, 'card_post', { id: 'pa-card', title: 'Create the marker file?', body: placement('create_marker', command) }), /Posted card pa-card/);

    // The agent cannot approve its own card.
    const forged = await fetch(`${h.server.url}/v1/cards/pa-card/answer`, { method: 'POST', headers: { authorization: `Bearer ${h.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: { create_marker: await sealAsPage(command) } }) });
    assert.equal(forged.status, 403);
    assert.ok(!fs.existsSync(marker));

    const res = await h.owner('POST', '/v1/cards/pa-card/answer', { values: { create_marker: await sealAsPage(command) }, version: 1 });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran', 'the command ran');

    // 1. The card's reply: the answer on the agent stream, and the card as the agent reads it.
    const ev = await until(() => listener.events.find((e) => e.type === 'answer' && e.card.id === 'pa-card'));
    assert.ok(ev.type === 'answer');
    const read = await runTool(ctx, 'card_read', { card_id: 'pa-card' });
    const asAgent = await (await fetch(`${h.server.url}/v1/cards/pa-card`, { headers: { authorization: `Bearer ${h.agentToken}` } })).text();
    // The text a harness gives the model for the answer.
    const said = describeAnswer(ev.card as Card, ev.answer);
    for (const text of [JSON.stringify(listener.events), read, asAgent, said]) assert.ok(!text.includes(PASSWORD), 'the reply holds no password');
    assert.match(said, /create_marker: ran on test-machine, exit code 0 \(audit \w+\)\. The command printed:/);

    // 2. The session's environment: the answer gives no grant, so no command the agent runs gets the password.
    const received = await secrets.receiveDetail(ev.card as Card, ev.answer);
    assert.deepEqual(received.granted, []);
    assert.ok(!JSON.stringify(secrets.env('pa-1')).includes(PASSWORD));

    // 3. The files under the inbox's home, the SQLite store and its journal included.
    assert.deepEqual(filesHolding(h.home, PASSWORD), []);

    // 4. What the command printed: it printed the password back, and the agent gets the mask instead.
    const run = ev.answer.values['create_marker'] as PrivilegedRun;
    assert.equal(run.exitCode, 0);
    assert.equal(run.machine, MACHINE);
    assert.match(run.output, new RegExp(`authenticated with ${PASSWORD_MASK.replace(/[[\]]/g, '\\$&')}`));
    assert.match(run.output, /the environment is clean/);
    assert.ok(!run.output.includes(PASSWORD));

    // The audit names who approved which command on which machine, and only the owner reads it.
    const audit = await (await h.owner('GET', '/v1/privileged/audit')).json() as { audit: { command: string; machine: string; approvedBy: string; card: string }[] };
    assert.deepEqual(audit.audit.map((a) => ({ card: a.card, command: a.command, machine: a.machine })), [{ card: 'pa-card', command, machine: MACHINE }]);
    assert.match(audit.audit[0]!.approvedBy, /^page on /);
    assert.equal((await fetch(`${h.server.url}/v1/privileged/audit`, { headers: { authorization: `Bearer ${h.agentToken}` } })).status, 403);
    listener.stop();
  });

  it('refuses a command that differs from the card by one character, and runs nothing', async () => {
    const marker = path.join(work, 'not-made');
    const command = commandFor(marker);
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const ctx = { inbox: client, secrets: new SecretRequests(), agent: 'pa-2', origin: async () => undefined, arrival: 'later' };
    await runTool(ctx, 'card_post', { id: 'pa-other', title: 'Create the other marker?', body: placement('create_marker', command) });
    const changed = command.replace('not-made', 'not-mAde');
    const res = await h.owner('POST', '/v1/cards/pa-other/answer', { values: { create_marker: await sealAsPage(changed) } });
    assert.equal(res.status, 409);
    const { error } = await res.json() as { error: string };
    assert.match(error, /nothing ran, because the approved command differs from the card's at character \d+: the card has "a" and the approval has "A"/);
    assert.ok(!fs.existsSync(marker), 'the command did not run');
    assert.ok(!fs.existsSync(marker.replace('not-made', 'not-mAde')), 'the changed command did not run either');
  });

  it('reports a wrong password as the command printed it, and still never holds the password', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const ctx = { inbox: client, secrets: new SecretRequests(), agent: 'pa-3', origin: async () => undefined, arrival: 'later' };
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(PSEUDO)} --expect-sha256 ${'0'.repeat(64)} -- true`;
    await runTool(ctx, 'card_post', { id: 'pa-wrong', title: 'Try the wrong password?', body: placement('try_it', command) });
    const res = await h.owner('POST', '/v1/cards/pa-wrong/answer', { values: { try_it: await sealAsPage(command) } });
    assert.equal(res.status, 200);
    const run = (await res.json() as { values: Record<string, PrivilegedRun> }).values['try_it']!;
    assert.equal(run.exitCode, 1);
    assert.match(run.output, /wrong password/);
    assert.deepEqual(filesHolding(h.home, PASSWORD), []);
  });
});
