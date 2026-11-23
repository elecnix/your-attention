#!/usr/bin/env node
// The Claude Code plugin runs this for its channel server and for each hook
// call. A machine that already has the CLI on PATH uses that one: a hook runs
// up to six times per AskUserQuestion, and a download per call would be slow.
// Without the CLI, the plugin runs the package version its manifest pins.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);

const onPath = spawnSync('your-attention', args, { stdio: 'inherit' });
if (!onPath.error) process.exit(onPath.status ?? 1);
if (onPath.error.code !== 'ENOENT') {
  console.error(`claude-plugin-runner: ${onPath.error.message}`);
  process.exit(1);
}

const root = path.join(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));

// npm resolves a local package name before the published one, so npx runs from
// a neutral directory rather than the plugin checkout.
const pinned = spawnSync('npx', ['-y', `your-attention@${manifest.version}`, ...args], {
  stdio: 'inherit',
  cwd: os.tmpdir(),
});
if (pinned.error) {
  console.error(`claude-plugin-runner: cannot start npx: ${pinned.error.message}`);
  process.exit(1);
}
process.exit(pinned.status ?? 1);
