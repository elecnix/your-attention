#!/usr/bin/env node
// The far machine's sudo, which needs no privilege. It reads -k, -S, -n and -p PROMPT, then the command after --. It
// records its own argument list in far-argv.jsonl, as ps would show it on the far side. It refuses a command the
// "sudoers" of hosts.json doesn't list. With -S it reads one line of standard input as the password and checks its
// SHA-256 against "sudoSha256"; with -n it refuses unless "nopasswd". It writes its own line to the system log, as sudo
// does, then runs the command's words with no shell, in an environment that holds only PATH.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_SSH_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'far-argv.jsonl'), `${JSON.stringify(['sudo', ...args])}\n`);
const far = JSON.parse(fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8'))[process.env.FAKE_FAR_HOST];
let i = 0;
let readPassword = false;
let nonInteractive = false;
while (i < args.length) {
  const a = args[i];
  if (a === '--') { i++; break; }
  if (a === '-S') readPassword = true;
  else if (a === '-n') nonInteractive = true;
  else if (a === '-p') i++;
  else if (a !== '-k') { console.error(`sudo: unknown option ${a}`); process.exit(1); }
  i++;
}
const command = args.slice(i);
const syslog = (text) => fs.appendFileSync(path.join(dir, 'syslog'), `sudo: ${process.env.USER} : ${text} ; COMMAND=${command.join(' ')}\n`);
if (!(far.sudoers ?? []).some((a) => a.length === command.length && a.every((w, k) => w === command[k]))) {
  syslog('command not allowed');
  console.error(`Sorry, user ${process.env.USER} is not allowed to execute '${command.join(' ')}' as root on ${far.hostname}.`);
  process.exit(1);
}
if (readPassword) {
  const password = fs.readFileSync(0, 'utf8').split('\n')[0];
  if (createHash('sha256').update(password).digest('hex') !== far.sudoSha256) {
    syslog('1 incorrect password attempt');
    console.error('sudo: 1 incorrect password attempt');
    process.exit(1);
  }
} else if (nonInteractive && !far.nopasswd) {
  console.error('sudo: a password is required');
  process.exit(1);
}
syslog('USER=root');
const run = spawnSync(command[0], command.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: '/usr/bin:/bin' } });
process.exit(run.status ?? 1);
