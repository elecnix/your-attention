// Whether the Claude Code session that started this channel turned channel notifications on.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { devChannelEnabled, psOptions } from '../../src/integrations/claude/channel-flag.ts';

describe('the development-channels flag of the parent', () => {
  it('is on when the flag names server:your-attention, joined with = or as the next word', () => {
    const claude = (words: string[]) => ['/usr/local/bin/claude', ...words];
    assert.equal(devChannelEnabled(claude(['--dangerously-load-development-channels=server:your-attention'])), true);
    assert.equal(devChannelEnabled(claude(['--dangerously-load-development-channels', 'server:your-attention'])), true);
    assert.equal(devChannelEnabled(claude(['--resume', '--dangerously-load-development-channels=server:other,server:your-attention'])), true);
  });

  it('is off without the flag, with another server, or with the flag left without a value', () => {
    const claude = (words: string[]) => ['/usr/local/bin/claude', ...words];
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
    assert.equal(devChannelEnabled(['/usr/local/bin/claude', '-p', 'why does --dangerously-load-development-channels server:your-attention drop answers']), false);
    assert.equal(devChannelEnabled(['/usr/local/bin/claude', 'why does --dangerously-load-development-channels=server:your-attention drop answers']), false);
    // ps loses the quotes, so the words of the prompt reach no option scan.
    assert.deepEqual(psOptions('claude -p why does --dangerously-load-development-channels server:your-attention drop answers'), ['-p']);
    assert.deepEqual(psOptions('claude why does --dangerously-load-development-channels=server:your-attention drop'), []);
  });

  it('keeps scanning options a prompt has not started yet, whatever their values', () => {
    assert.deepEqual(psOptions('claude --model opus --dangerously-load-development-channels=server:your-attention'), ['--model', 'opus', '--dangerously-load-development-channels=server:your-attention']);
    assert.deepEqual(psOptions('claude --dangerously-load-development-channels server:your-attention -p hi'), ['--dangerously-load-development-channels', 'server:your-attention', '-p']);
    assert.equal(devChannelEnabled(['/usr/local/bin/claude', ...psOptions('claude --model opus --dangerously-load-development-channels=server:your-attention')]), true);
  });
});
