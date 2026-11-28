// The Claude Code plugin manifest adds a second copy of the version and a set
// of hooks that run outside this process, so each one is checked against the
// file it has to agree with.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { nodeBuild } from '../../src/node/build.ts';

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
  it('keeps its version in step with package.json and the build the inbox reports', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    assert.equal(pluginJson.version, pkg.version);
    assert.equal(pluginJson.version, nodeBuild().version);
  });

  it('serves the channel server this package implements', () => {
    const server = pluginJson.mcpServers['your-attention'];
    assert.ok(server, 'the manifest declares the your-attention server');
    assert.equal(server.command, 'node');
    assert.match(server.args?.[0] ?? '', /claude-plugin-runner\.js$/);
    assert.equal(server.args?.[1], 'claude-channel');
    assert.deepEqual(pluginJson.channels?.map((channel) => channel.server), ['your-attention']);
  });

  it('points every hook at the bundled runner', () => {
    const commands = Object.values(hooksJson.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );
    assert.ok(commands.length >= 6);
    for (const command of commands) {
      assert.match(command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-plugin-runner\.js" claude-hook /);
    }
    const runner = path.join(root, 'bin', 'claude-plugin-runner.js');
    // Windows checks out without POSIX permission bits, so the mode carries no meaning there.
    if (process.platform !== 'win32') assert.ok(fs.statSync(runner).mode & 0o111, 'the runner is executable');
  });

  it('records the turn end when a session stops', () => {
    const stop = hooksJson.hooks.Stop;
    assert.ok(stop, 'the manifest registers the Stop hook');
    const commands = stop.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.deepEqual(commands, ['node "${CLAUDE_PLUGIN_ROOT}/bin/claude-plugin-runner.js" claude-hook turn-end']);
  });
});
