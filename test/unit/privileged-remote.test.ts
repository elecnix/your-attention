// Privileged actions on another machine, without ssh: the words the broker reads from a command, the quoting that
// carries them through the far side's shell, the machines of machines.jsonl and the sudoers rule each one needs, and
// the inbox picking the one runner a card's machine names. test/integration/privileged-remote.test.ts runs it end to end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { auditLine, parseCommand, readMachine, remoteCommand, shellQuote, sudoersRule, uncovered, type PrivilegedRunner, type RemoteMachine } from '../../src/core/privileged.ts';
import { sealValue } from '../../src/core/sealed.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { loadMachines, sshArgs } from '../../src/node/privileged.ts';

const PASSWORD = 'FIXTURE-PASSWORD-DO-NOT-USE';
const WEB1: RemoteMachine = { name: 'web1', host: 'web1.lan', user: 'deploy', hostname: 'web1', sudo: 'password', allow: ['/usr/bin/systemctl restart nginx', `/usr/bin/printf '%s|' "it's here" 'costs $5'`] };
/** The far side's shell is POSIX sh, which Windows lacks, so the tests that compare with it skip there. */
const NEEDS_SH = { skip: process.platform === 'win32' ? 'compares with /bin/sh' : false };
const rejects = (status: number, message: RegExp) => (e: unknown) => e instanceof InboxError && e.status === status && message.test(e.message);

/** The words /bin/sh reads from a line, as printf prints each one between NUL bytes. */
function shellWords(line: string): string[] {
  const out = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${line}`], { encoding: 'utf8' });
  return out.stdout.split('\0').slice(0, -1);
}

describe('the words of a command', () => {
  it('reads quotes and backslashes as sh does, so the words match what the person reads', NEEDS_SH, () => {
    for (const command of [
      '/usr/bin/systemctl restart nginx',
      `/usr/bin/printf '%s|' "it's here" 'costs $5 or $HOME'`,
      `/bin/echo a\\ b "c \\"d\\" \\\\e" ''`,
      `/bin/echo 'a''b'"c"d`,
    ]) assert.deepEqual(parseCommand(command), shellWords(command), command);
  });

  it('refuses shell syntax, which the broker never runs, and names where it is', () => {
    assert.throws(() => parseCommand('/bin/ls; /bin/rm -rf /'), /the ; at character 8 is shell syntax/);
    assert.throws(() => parseCommand('/bin/echo $HOME'), /the \$ at character 11 is shell syntax/);
    assert.throws(() => parseCommand('/bin/echo "$HOME"'), /sits in double quotes, where a shell would expand it/);
    assert.throws(() => parseCommand('/bin/echo `id`'), /shell syntax/);
    assert.throws(() => parseCommand('/bin/ls *'), /shell syntax/);
    assert.throws(() => parseCommand('/bin/ls > /tmp/x'), /shell syntax/);
    assert.throws(() => parseCommand("/bin/echo 'open"), /never closed/);
    assert.throws(() => parseCommand('/bin/echo a\n/bin/rm'), /line break/);
    assert.throws(() => parseCommand('  '), /empty/);
  });

  it('quotes each word so the far side reads it back unchanged', NEEDS_SH, () => {
    const words = ['/usr/bin/printf', '%s|', "it's here", 'costs $5 or $HOME', 'a "b" `c` \\d', '', ';|&'];
    assert.deepEqual(shellWords(words.map(shellQuote).join(' ')), words);
  });
});

describe('the line the far side runs', () => {
  const ctx = { audit: 'a1b2', card: 'c1', field: 'restart', approvedBy: "page on Nico's laptop\nforged line" };
  it('checks the machine, writes the audit line, then execs sudo with the words and no password', () => {
    const line = remoteCommand(WEB1, WEB1.allow[1]!, ctx);
    assert.ok(!line.includes(PASSWORD));
    assert.match(line, /^h=\$\(uname -n\); h=\$\{h%%\.\*\}; if \[ "\$h" != 'web1' \]/);
    assert.match(line, /logger -t your-attention -p authpriv\.notice -- /);
    assert.ok(line.endsWith(`exec sudo -k -S -p '' -- '/usr/bin/printf' '%s|' 'it'\\''s here' 'costs $5'`), line);
    assert.ok(remoteCommand({ ...WEB1, sudo: 'approval' }, WEB1.allow[0]!, ctx).endsWith(`exec sudo -k -n -- '/usr/bin/systemctl' 'restart' 'nginx'`));
    // The audit line is one line, whatever the token name holds.
    assert.equal(auditLine('web1', 'x', ctx), "audit a1b2: page on Nico's laptop forged line approved card c1 field restart to run on web1: x");
  });

  it('gives ssh no prompt, a known host key only, and the line as its last argument', () => {
    const args = sshArgs({ ...WEB1, port: 2222 }, 'LINE');
    assert.deepEqual(args.slice(-7), ['-l', 'deploy', '-p', '2222', '--', 'web1.lan', 'LINE']);
    for (const o of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes']) assert.ok(args.includes(o), o);
  });
});

describe('the machines of machines.jsonl', () => {
  it('reads a machine, and says what is wrong with a line that is not one', () => {
    assert.deepEqual(readMachine({ name: 'nas', user: 'admin', sudo: 'approval', allow: ['/usr/bin/systemctl restart smbd'] }), { name: 'nas', host: 'nas', user: 'admin', hostname: 'nas', sudo: 'approval', allow: ['/usr/bin/systemctl restart smbd'] });
    assert.match(String(readMachine({ name: 'x', host: '-oProxyCommand=evil', user: 'u', sudo: 'password', allow: ['/bin/true'] })), /host must be an ssh host that doesn't start with -/);
    assert.match(String(readMachine({ name: 'x', user: 'u', sudo: 'maybe', allow: ['/bin/true'] })), /sudo must be "password"/);
    assert.match(String(readMachine({ name: 'x', user: 'u', sudo: 'password', allow: ['systemctl restart nginx'] })), /not an absolute path/);
    assert.match(String(readMachine({ name: 'x', user: 'u', sudo: 'password', allow: [`/bin/echo 'a  b'`] })), /whitespace other than single spaces/);
    assert.match(String(readMachine({ name: 'x', user: 'u', sudo: 'password', allow: ['/bin/ls | /bin/sh'] })), /shell syntax/);
  });

  it('refuses a machine named as this inbox, and a name given twice', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-machines-'));
    const line = (name: string) => JSON.stringify({ name, user: 'u', sudo: 'password', allow: ['/bin/true'] });
    fs.writeFileSync(path.join(home, 'machines.jsonl'), [line('laptop'), line('web1'), line('web1'), 'not json', ''].join('\n'));
    const { machines, problems } = loadMachines(home, 'laptop');
    assert.deepEqual(machines.map((m) => m.name), ['web1']);
    assert.deepEqual(problems, [
      "line 1 of machines.jsonl: laptop is this inbox's own machine, which runs its commands without ssh",
      'line 3 of machines.jsonl: web1 is already on an earlier line',
      'line 4 of machines.jsonl is not JSON',
    ]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('covers only the exact words of an allowed command', () => {
    assert.equal(uncovered(WEB1, '/usr/bin/systemctl  restart   nginx'), undefined, 'the same words, spaced differently');
    assert.equal(uncovered(WEB1, `/usr/bin/printf %s\\| "it's here" costs\\ \\$5`), undefined, 'the same words, quoted differently');
    assert.match(uncovered(WEB1, '/usr/bin/systemctl restart nginx.service') ?? '', /the sudoers rule of web1 doesn't cover it/);
    assert.match(uncovered(WEB1, '/usr/bin/systemctl restart nginx; /bin/sh') ?? '', /shell syntax/);
  });

  it('prints the sudoers rule: a password for a password machine, none for an approval machine', () => {
    assert.equal(sudoersRule(WEB1), [
      '# The commands a person may approve on web1 from a your-attention card. The broker refuses any other.',
      '# Install on web1 with: sudo visudo -f /etc/sudoers.d/your-attention',
      'Cmnd_Alias YOUR_ATTENTION_WEB1 = /usr/bin/systemctl restart nginx, \\',
      "    /usr/bin/printf %s| it's here costs $5",
      'deploy ALL=(root) YOUR_ATTENTION_WEB1',
      '',
    ].join('\n'));
    assert.match(sudoersRule({ ...WEB1, name: 'nas-2', sudo: 'approval', allow: ["/bin/echo 'a,b:c=d*'"] }), /Cmnd_Alias YOUR_ATTENTION_NAS_2 = \/bin\/echo a\\,b\\:c\\=d\\\*\ndeploy ALL=\(root\) NOPASSWD: YOUR_ATTENTION_NAS_2/);
  });
});

describe('the inbox with several machines', () => {
  const agent: Caller = { token: 'ta', role: 'agent' };
  const body = (command: string, machine: string) => `root = Card([run])\nrun = widget privileged_action ${JSON.stringify({ name: 'run_it', command, machine, changes: 'Restarts nginx' })}`;
  const runner = (machine: string, sudo: 'password' | 'approval', calls: string[]): PrivilegedRunner => ({
    machine, sudo, refuse: (c) => (c.includes('nginx') ? undefined : `${machine} allows nginx only`), run: async (c, p) => { calls.push(`${machine}: ${c} with ${p ? 'a password' : 'none'}`); return { exitCode: 0, output: '' }; },
  });

  it('runs each card on the one runner its machine names, and refuses a machine none serves', async () => {
    const calls: string[] = [];
    const inbox = new Inbox(new MemoryStorage(), () => 1_800_000_000_000, undefined, { privileged: [runner('laptop', 'password', calls), runner('web1', 'password', calls), runner('nas', 'approval', calls)] });
    const { token } = await inbox.createToken('page', 'owner');
    const owner: Caller = { token: token.id, role: 'owner' };
    const key = await inbox.privilegedKey(owner);
    assert.equal(key.machine, 'laptop');
    assert.deepEqual(key.machines, [{ name: 'laptop', sudo: 'password' }, { name: 'web1', sudo: 'password' }, { name: 'nas', sudo: 'approval' }]);

    assert.throws(() => inbox.postCard(agent, { agent: 's', title: 'Run?', body: body('/usr/bin/systemctl restart nginx', 'web2') }), rejects(400, /runs commands on laptop, web1, nas only, not on web2/));
    assert.throws(() => inbox.postCard(agent, { agent: 's', title: 'Run?', body: body('/usr/bin/id', 'web1') }), rejects(400, /nothing ran, because web1 allows nginx only/));

    const cmd = '/usr/bin/systemctl restart nginx';
    inbox.postCard(agent, { id: 'w', agent: 's', title: 'Run?', body: body(cmd, 'web1') });
    await inbox.answer('w', { values: { run_it: await sealValue(key.publicKey, JSON.stringify({ command: cmd, password: PASSWORD })) }, by: owner });
    inbox.postCard(agent, { id: 'n', agent: 's', title: 'Run?', body: body(cmd, 'nas') });
    await assert.rejects(inbox.answer('n', { values: { run_it: await sealValue(key.publicKey, JSON.stringify({ command: cmd, password: PASSWORD })) }, by: owner }), rejects(400, /nas takes an approval, not a password/));
    await inbox.answer('n', { values: { run_it: await sealValue(key.publicKey, JSON.stringify({ command: cmd, password: '', approve: true })) }, by: owner });
    assert.deepEqual(calls, [`web1: ${cmd} with a password`, `nas: ${cmd} with none`]);
  });

  it('takes one runner per machine', () => {
    assert.throws(() => new Inbox(new MemoryStorage(), () => 0, undefined, { privileged: [runner('web1', 'password', []), runner('web1', 'approval', [])] }), /two runners of privileged actions serve the machine web1/);
  });
});
