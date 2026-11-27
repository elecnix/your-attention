#!/usr/bin/env node
// A stand-in for `sudo -S`, which needs no privilege: it reads a password on its standard input, checks its SHA-256
// against --expect-sha256, and runs the command after `--` as the same user. It prints the password back on purpose,
// as a careless command would, so a test proves the broker masks it. It also says whether its own environment holds
// the password, which it must not.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const expect = args[args.indexOf('--expect-sha256') + 1];
const command = args.slice(args.indexOf('--') + 1);
const password = readFileSync(0, 'utf8').split('\n')[0];
if (createHash('sha256').update(password).digest('hex') !== expect) {
  console.error('pseudo-sudo: wrong password');
  process.exit(1);
}
console.log(`pseudo-sudo: authenticated with ${password}`);
console.log(Object.values(process.env).some((v) => v?.includes(password)) ? 'pseudo-sudo: the environment holds the password' : 'pseudo-sudo: the environment is clean');
const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
process.exit(run.status ?? 1);
