// The Claude Code plugin manifest adds a second copy of the version and a set
// of hooks that run outside this process, so each one is checked against the
// file it has to agree with.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { VERSION } from '../../src/core/version.ts';

const root = path.join(import.meta.dirname, '..', '..');
const pluginJson = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as {
  version: string;
  mcpServers: Record<string, { command: string; args?: string[] }>;
  channels?: { server: string }[];
};
const hooksJson = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')) as {
  hooks: Record<string, { hooks: { command: string }[] }[]>;
};

describe('the Claude Code plugin manifest', () => {
  it('keeps its version in step with package.json and VERSION', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    assert.equal(pluginJson.version, pkg.version);
    assert.equal(pluginJson.version, VERSION);
  });

  it('serves the channel server this package implements', () => {
    const server = pluginJson.mcpServers['your-attention'];
    assert.ok(server, 'the manifest declares the your-attention server');
    assert.equal(server.args?.[0], 'claude-channel');
    assert.deepEqual(pluginJson.channels?.map((channel) => channel.server), ['your-attention']);
  });

  it('points every hook at the bundled runner', () => {
    const commands = Object.values(hooksJson.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );
    assert.ok(commands.length >= 6);
    for (const command of commands) {
      assert.match(command, /^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-plugin-runner\.sh claude-hook /);
    }
    const runner = path.join(root, 'bin', 'claude-plugin-runner.sh');
    assert.ok(fs.statSync(runner).mode & 0o111, 'the runner is executable');
  });
});
