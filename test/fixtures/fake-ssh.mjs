#!/usr/bin/env node
// A stand-in for ssh, for the remote privileged action tests. It reads hosts.json in $FAKE_SSH_DIR, which maps each ssh
// host to the far machine it reaches: {"hostname", "refuse"?, "cutAfterMs"?, "sudoers": [[argv...]], "nopasswd"?,
// "sudoSha256"?}. It records its own argument list in ssh-argv.jsonl, as ps would show it on this machine. Then it
// refuses the connection, or runs the one line with /bin/sh in a far environment, which shares nothing with this
// process but $FAKE_SSH_DIR: PATH starts with test/fixtures/far-bin, whose sudo, logger and uname stand in for the far
// machine's. It streams standard input, output and error, and with cutAfterMs it cuts the connection mid-run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.FAKE_SSH_DIR;
if (!dir) { console.error('fake-ssh: set FAKE_SSH_DIR'); process.exit(255); }
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'ssh-argv.jsonl'), `${JSON.stringify(['ssh', ...args])}\n`);

// Options that take a value, as OpenSSH reads them; every other dash word is a flag. `--` ends the options.
const WITH_VALUE = new Set(['-o', '-l', '-p', '-i', '-F', '-J', '-b', '-c', '-m', '-E', '-S', '-W', '-L', '-R', '-D']);
let i = 0;
let user = process.env.USER ?? 'nobody';
while (i < args.length && args[i].startsWith('-')) {
  if (args[i] === '--') { i++; break; }
  if (args[i] === '-l') user = args[i + 1];
  i += WITH_VALUE.has(args[i]) ? 2 : 1;
}
const host = args[i];
const line = args.slice(i + 1).join(' ');
const hosts = JSON.parse(fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8'));
const far = hosts[host];
if (!far) { console.error(`ssh: Could not resolve hostname ${host}: Name or service not known`); process.exit(255); }
if (far.refuse) { console.error(`ssh: connect to host ${host} port 22: Connection refused`); process.exit(255); }

const farBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'far-bin');
const farHome = path.join(dir, 'far-home');
fs.mkdirSync(farHome, { recursive: true });
// What ps shows on the far side: the login shell that runs the line.
fs.appendFileSync(path.join(dir, 'far-argv.jsonl'), `${JSON.stringify(['/bin/sh', '-c', line])}\n`);
const child = spawn('/bin/sh', ['-c', line], {
  cwd: farHome,
  env: { PATH: [farBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: farHome, USER: user, LOGNAME: user, FAKE_SSH_DIR: dir, FAKE_FAR_HOST: host },
  stdio: ['pipe', 'inherit', 'inherit'],
  // Its own process group, so a cut connection ends the far command too, as sshd's hangup does.
  detached: true,
});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
if (far.cutAfterMs) {
  setTimeout(() => {
    process.kill(-child.pid, 'SIGKILL');
    console.error(`Connection to ${host} closed by remote host.`);
    process.exit(255);
  }, far.cutAfterMs);
}
child.on('close', (code) => process.exit(code ?? 255));
