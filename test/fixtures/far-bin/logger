#!/usr/bin/env node
// The far machine's logger: it appends `tag: message` to $FAKE_SSH_DIR/syslog, as logger -t TAG -p PRIO -- MESSAGE
// writes to the system log. With "noSyslog" in hosts.json, it fails as a logger with no log to write to.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const far = JSON.parse(fs.readFileSync(path.join(process.env.FAKE_SSH_DIR, 'hosts.json'), 'utf8'))[process.env.FAKE_FAR_HOST];
if (far.noSyslog) { console.error('logger: socket /dev/log: No such file or directory'); process.exit(1); }
const tag = args[args.indexOf('-t') + 1];
const message = args.slice(args.indexOf('--') + 1).join(' ');
fs.appendFileSync(path.join(process.env.FAKE_SSH_DIR, 'syslog'), `${tag}: ${message}\n`);
