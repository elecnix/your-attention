// A privileged action on another machine, end to end on the laptop server. test/fixtures/fake-ssh.mjs stands in for
// ssh: it reaches a far machine whose sudo, logger and uname are the stand-ins in test/fixtures/far-bin, and it records
// the argument list of ssh on this side and of the shell and sudo on the far side, as ps would show them. Each test
// posts a card with card_post, seals as the page does, and reads what came back and what each side recorded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, describeAnswer } from '../../src/client.ts';
import { parseCommand, PASSWORD_MASK, type PrivilegedRun, type RemoteMachine } from '../../src/core/privileged.ts';
import type { Card } from '../../src/core/types.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { localRunner, sshRunner } from '../../src/node/privileged.ts';
import { seal } from '../../web/sealed.js';
import { ROOT, start, until, type Harness } from './harness.ts';

const PASSWORD = 'FIXTURE-PASSWORD-DO-NOT-USE';
const FAKE_SSH = path.join(ROOT, 'test', 'fixtures', 'fake-ssh.mjs');

let h: Harness;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-remote-'));
let savedDir: string | undefined;
const marker = (name: string) => path.join(dir, `marker-${name}`);
const touch = (name: string) => `/usr/bin/touch ${marker(name)}`;
/** Quotes, spaces and a dollar sign, which a careless quoting through ssh would change or expand. */
const QUOTED = `/usr/bin/printf '%s|' "it's here" 'costs $5 or $HOME' "a \\"b\\""`;

const machine = (name: string, sudo: 'password' | 'approval', allow: string[]): RemoteMachine => ({ name, host: `${name}.test`, user: 'deploy', hostname: name.replace(/-/g, ''), sudo, allow });
const MACHINES: RemoteMachine[] = [
  machine('far-pw', 'password', [QUOTED, touch('pw')]),
  machine('far-ok', 'approval', [touch('ok')]),
  machine('far-down', 'password', [touch('down')]),
  machine('far-wrong', 'password', [touch('wrong')]),
  machine('far-cut', 'password', ['/bin/sleep 20']),
  machine('far-nolog', 'password', [touch('nolog')]),
];

before(async () => {
  const sha = createHash('sha256').update(PASSWORD).digest('hex');
  const far = (m: RemoteMachine, extra: Record<string, unknown> = {}) => [m.host, { hostname: m.hostname, sudoers: m.allow.map(parseCommand), sudoSha256: sha, ...extra }];
  const [pw, ok, down, wrong, cut, nolog] = MACHINES as [RemoteMachine, RemoteMachine, RemoteMachine, RemoteMachine, RemoteMachine, RemoteMachine];
  fs.writeFileSync(path.join(dir, 'hosts.json'), JSON.stringify(Object.fromEntries([
    far(pw), far(ok, { nopasswd: true }), far(down, { refuse: true }), far(wrong, { hostname: 'imposter' }), far(cut, { cutAfterMs: 2500 }), far(nolog, { noSyslog: true }),
  ])));
  savedDir = process.env['FAKE_SSH_DIR'];
  process.env['FAKE_SSH_DIR'] = dir;
  h = await start({ privileged: [localRunner('test-machine'), ...MACHINES.map((m) => sshRunner(m, { ssh: FAKE_SSH }))] });
});
after(async () => {
  await h.stop();
  if (savedDir === undefined) delete process.env['FAKE_SSH_DIR'];
  else process.env['FAKE_SSH_DIR'] = savedDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const placement = (name: string, command: string, on: string) => `root = Card([run])\nrun = widget privileged_action ${JSON.stringify({ name, command, machine: on, changes: 'Runs a fixture command on the far machine' })}`;

/** Seal as the page does, to the key GET /v1/privileged/key answers. */
async function sealAsPage(plain: Record<string, unknown>): Promise<unknown> {
  const key = await (await h.owner('GET', '/v1/privileged/key')).json() as { publicKey: JsonWebKey };
  return seal(key.publicKey, JSON.stringify(plain));
}

/** Each line of a record the fake ssh or a far stand-in wrote, or none. */
const lines = (file: string): string[] => { try { return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean); } catch { return []; } };

/** Every file under `root` whose bytes hold `needle`. */
function filesHolding(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(root);
  return hits;
}

const agentCtx = (agent: string) => ({ inbox: new Client({ url: h.server.url, token: h.agentToken }), secrets: new SecretRequests(), agent, origin: async () => undefined, arrival: 'later' });

/** Post a card for one command on one machine, answer it as the owner, and give the run the answer stored. */
async function approve(id: string, command: string, on: string, plain: Record<string, unknown> = { command, password: PASSWORD }): Promise<PrivilegedRun> {
  assert.match(await runTool(agentCtx(`agent-${id}`), 'card_post', { id, title: `Run on ${on}?`, body: placement('run_it', command, on) }), new RegExp(`Posted card ${id}`));
  const res = await h.owner('POST', `/v1/cards/${id}/answer`, { values: { run_it: await sealAsPage(plain) } });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json() as { values: Record<string, PrivilegedRun> }).values['run_it']!;
}

describe('a privileged action on another machine', () => {
  it('runs on the far machine through sudo, and the password reaches nothing the agent reads', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const listener = h.listen(client, 'agent-r1');
    await until(async () => (await h.stored()).presence['agent-r1']?.online);
    const run = await approve('r1', QUOTED, 'far-pw');
    assert.equal(run.exitCode, 0, run.ended ?? run.output);
    assert.equal(run.machine, 'far-pw');

    // The command's words reached sudo on the far side as the card shows them: quotes, spaces and $ unchanged.
    const sudo = lines('far-argv.jsonl').map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === 'sudo').pop()!;
    assert.deepEqual(sudo, ['sudo', '-k', '-S', '-p', '', '--', '/usr/bin/printf', '%s|', "it's here", 'costs $5 or $HOME', 'a "b"']);
    assert.match(run.output, /it's here\|costs \$5 or \$HOME\|a "b"\|/);

    // The audit line is in the far machine's system log, before sudo's own line, with the audit id the answer carries.
    const syslog = lines('syslog');
    const ours = syslog.findIndex((l) => l.startsWith(`your-attention: audit ${run.audit}: `) && l.includes('field run_it to run on far-pw: /usr/bin/printf'));
    assert.ok(ours >= 0, syslog.join('\n'));
    assert.ok(syslog.findIndex((l, i) => i > ours && l.startsWith('sudo: deploy : USER=root ; COMMAND=/usr/bin/printf')) > ours);

    // 1. The reply: the agent stream, card_read, the card as the agent reads it, and the answer text for the model.
    const ev = await until(() => listener.events.find((e) => e.type === 'answer' && e.card.id === 'r1'));
    assert.ok(ev.type === 'answer');
    const said = describeAnswer(ev.card as Card, ev.answer);
    assert.match(said, /run_it: ran on far-pw, exit code 0 \(audit \w+\)/);
    const read = await runTool(agentCtx('agent-r1'), 'card_read', { card_id: 'r1' });
    const asAgent = await (await fetch(`${h.server.url}/v1/cards/r1`, { headers: { authorization: `Bearer ${h.agentToken}` } })).text();
    for (const text of [JSON.stringify(listener.events), read, asAgent, said, run.output]) assert.ok(!text.includes(PASSWORD));
    // 2. The agent's environment: this process's own, and the session's grants.
    assert.ok(!JSON.stringify(process.env).includes(PASSWORD));
    const secrets = new SecretRequests();
    assert.deepEqual((await secrets.receiveDetail(ev.card as Card, ev.answer)).granted, []);
    // 3. The files under the inbox's home, and the far side's own home and log.
    assert.deepEqual(filesHolding(h.home, PASSWORD), []);
    assert.ok(!lines('syslog').join('\n').includes(PASSWORD));
    listener.stop();
  });

  it('runs on a machine that takes an approval, and sends that machine no password', async () => {
    const run = await approve('r2', touch('ok'), 'far-ok', { command: touch('ok'), password: '', approve: true });
    assert.equal(run.exitCode, 0, run.ended ?? run.output);
    assert.ok(fs.existsSync(marker('ok')));
    const sudo = lines('far-argv.jsonl').map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === 'sudo').pop()!;
    assert.deepEqual(sudo.slice(0, 4), ['sudo', '-k', '-n', '--']);

    // A password sealed for that machine is refused rather than sent anywhere.
    await runTool(agentCtx('agent-r2b'), 'card_post', { id: 'r2b', title: 'Run on far-ok?', body: placement('run_it', touch('ok'), 'far-ok') });
    const res = await h.owner('POST', '/v1/cards/r2b/answer', { values: { run_it: await sealAsPage({ command: touch('ok'), password: PASSWORD }) } });
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /far-ok takes an approval, not a password/);
  });

  it('refuses a command the sudoers rule does not cover before anything runs, and says so', async () => {
    const before = lines('ssh-argv.jsonl').length;
    const text = await runTool(agentCtx('agent-r3'), 'card_post', { id: 'r3', title: 'Run on far-pw?', body: placement('run_it', '/usr/bin/touch /tmp/not-allowed', 'far-pw') }).catch((e: Error) => e.message);
    assert.match(text, /the sudoers rule of far-pw doesn't cover it, so the broker refuses it before anything runs/);
    assert.match(text, /your-attention machines sudoers far-pw/);
    // Shell syntax is refused too, since the broker runs no shell.
    const piped = await runTool(agentCtx('agent-r3'), 'card_post', { id: 'r3b', title: 'Run on far-pw?', body: placement('run_it', `${touch('pw')}; /bin/rm -rf /tmp/x`, 'far-pw') }).catch((e: Error) => e.message);
    assert.match(piped, /the ; at character \d+ is shell syntax/);
    // A card for a machine no runner serves is refused, and never runs on another.
    const nowhere = await runTool(agentCtx('agent-r3'), 'card_post', { id: 'r3c', title: 'Run on far-nowhere?', body: placement('run_it', touch('pw'), 'far-nowhere') }).catch((e: Error) => e.message);
    assert.match(nowhere, /not on far-nowhere/);
    // The runner itself refuses too, without starting ssh.
    const runner = sshRunner(MACHINES[0]!, { ssh: FAKE_SSH });
    const result = await runner.run('/usr/bin/touch /tmp/not-allowed', PASSWORD, { audit: 'x', card: 'c', field: 'f', approvedBy: 'test' });
    assert.equal(result.exitCode, null);
    assert.match(result.ended ?? '', /^nothing ran, because the sudoers rule of far-pw doesn't cover it/);
    assert.equal(lines('ssh-argv.jsonl').length, before, 'ssh never started');
  });

  it('treats a refused connection as a refusal, and runs nothing on this machine', async () => {
    const run = await approve('r4', touch('down'), 'far-down');
    assert.equal(run.exitCode, null);
    assert.match(run.ended ?? '', /^nothing ran on far-down or on this machine, because ssh could not connect to far-down \(far-down\.test\): ssh: connect to host far-down\.test port 22: Connection refused$/);
    assert.ok(!fs.existsSync(marker('down')), 'the command ran nowhere');
    assert.ok(lines('ssh-argv.jsonl').some((l) => l.includes('far-down.test')), 'the broker dialed far-down');
    assert.ok(!lines('far-argv.jsonl').some((l) => l.includes(marker('down'))), 'no far side ran it');
    assert.match(describeAnswer({ id: 'r4', privileged: ['run_it'] } as Card, { values: { run_it: run } } as never), /run_it: on far-down, nothing ran on far-down or on this machine, because ssh could not connect/);
  });

  it('refuses when the far side is another machine than the card names', async () => {
    const run = await approve('r5', touch('wrong'), 'far-wrong');
    assert.equal(run.exitCode, null);
    assert.match(run.ended ?? '', /because far-wrong\.test answered as another machine than far-wrong/);
    assert.match(run.output, /this machine is imposter, not farwrong, so nothing ran/);
    assert.ok(!fs.existsSync(marker('wrong')));
  });

  it('refuses when the far system log takes no audit line', async () => {
    const run = await approve('r6', touch('nolog'), 'far-nolog');
    assert.equal(run.exitCode, null);
    assert.match(run.ended ?? '', /because the system log of far-nolog took no audit line/);
    assert.ok(!fs.existsSync(marker('nolog')));
  });

  it('says a command may have run in part when the connection drops after sudo started', async () => {
    const run = await approve('r7', '/bin/sleep 20', 'far-cut');
    assert.equal(run.exitCode, null);
    assert.match(run.ended ?? '', /the connection to far-cut ended after sudo started, so the command may have run in part: Connection to far-cut\.test closed by remote host\. The system log of far-cut holds audit \w+/);
  });

  it('puts the password in no command line, on either side', () => {
    const all = [...lines('ssh-argv.jsonl'), ...lines('far-argv.jsonl')];
    assert.ok(all.length > 10, 'each side recorded its command lines');
    for (const l of all) assert.ok(!l.includes(PASSWORD), l);
    // ssh's own options: no prompt, a known host key, and no forwarding.
    const ssh = JSON.parse(lines('ssh-argv.jsonl')[0]!) as string[];
    for (const o of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no']) assert.ok(ssh.includes(o), o);
    assert.equal(PASSWORD_MASK, '[password]');
  });
});
