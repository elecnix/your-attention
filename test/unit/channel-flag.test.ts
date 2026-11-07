// Whether the Claude Code session that started this channel turned channel notifications on.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { devChannelEnabled, procArgs, psOptions } from '../../src/integrations/claude/channel-flag.ts';

const claude = (words: string[]): string[] => ['/usr/local/bin/claude', ...words];

describe('the development-channels flag of the parent', () => {
  it('is on when the flag names server:your-attention, joined with = or as the next word', () => {
    assert.equal(devChannelEnabled(claude(['--dangerously-load-development-channels=server:your-attention'])), true);
    assert.equal(devChannelEnabled(claude(['--dangerously-load-development-channels', 'server:your-attention'])), true);
    assert.equal(devChannelEnabled(claude(['--resume', '--dangerously-load-development-channels=server:other,server:your-attention'])), true);
  });

  it('is off without the flag, with another server, or with the flag left without a value', () => {
    assert.equal(devChannelEnabled(claude([])), false);
    assert.equal(devChannelEnabled(claude(['--dangerously-load-development-channels=server:other'])), false);
    assert.equal(devChannelEnabled(claude(['--dangerously-load-development-channels'])), false);
    assert.equal(devChannelEnabled(claude(['--dangerously-load-development-channels=plugin:x@y'])), false);
  });

  it('says nothing when it cannot read a command line, so no page claims the channel is off', () => {
    assert.equal(devChannelEnabled(undefined), undefined);
  });

  it('reads no flag out of a prompt that talks about it', () => {
    // An exact argument vector keeps the prompt in one word.
    assert.equal(devChannelEnabled(claude(['-p', 'why does --dangerously-load-development-channels server:your-attention drop answers'])), false);
    assert.equal(devChannelEnabled(claude(['why does --dangerously-load-development-channels=server:your-attention drop answers'])), false);
    // `-p` takes one word as its prompt, so a flag in a later argument is a flag the CLI itself reads.
    assert.equal(devChannelEnabled(claude(['-p', 'why', 'does', '--dangerously-load-development-channels=server:your-attention', 'drop', 'answers'])), true);
    // ps loses the quotes, so the words of the prompt reach no option scan.
    assert.deepEqual(psOptions('claude -p why does --dangerously-load-development-channels server:your-attention drop answers'), ['-p']);
    assert.deepEqual(psOptions('claude why does --dangerously-load-development-channels=server:your-attention drop'), []);
  });

  it('reads the flag from the byte exact argument vector, and from one a process rewrote its title in', () => {
    assert.deepEqual(procArgs('node\0script.mjs\0--flag\0'), ['node', 'script.mjs', '--flag']);
    assert.deepEqual(procArgs('claude --dangerously-load-development-channels=server:your-attention\0'), ['claude', '--dangerously-load-development-channels=server:your-attention']);
    assert.equal(devChannelEnabled(procArgs('claude --dangerously-load-development-channels=server:your-attention\0')), true);
    assert.deepEqual(procArgs(''), []);
  });

  it('reads the flag after a settings value that ps split at a space', () => {
    // `ps` joins the arguments with spaces, so a settings JSON that holds a quoted command splits into several words.
    const line = ['claude', '--settings', '{"apiKeyHelper":"\"/Users/me/prizmal\" auth token","model":"core[1m]"}', '--resume', '8d935d18', '--allow-dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:your-attention'].join(' ');
    assert.equal(devChannelEnabled(['claude', ...psOptions(line)]), true);
  });

  it('keeps scanning options a prompt has not started yet, whatever their values', () => {
    assert.deepEqual(psOptions('claude --model opus --dangerously-load-development-channels=server:your-attention'), ['--model', 'opus', '--dangerously-load-development-channels=server:your-attention']);
    assert.deepEqual(psOptions('claude --dangerously-load-development-channels server:your-attention -p hi'), ['--dangerously-load-development-channels', 'server:your-attention', '-p']);
    assert.equal(devChannelEnabled(claude(psOptions('claude --model opus --dangerously-load-development-channels=server:your-attention'))), true);
  });
});
