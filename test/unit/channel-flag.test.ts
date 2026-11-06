// Whether the Claude Code session that started this channel turned channel notifications on.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { devChannelEnabled } from '../../src/integrations/claude/channel-flag.ts';

describe('the development-channels flag of the parent', () => {
  it('is on when the flag names server:your-attention, joined with = or as the next word', () => {
    assert.equal(devChannelEnabled('claude --dangerously-load-development-channels=server:your-attention'), true);
    assert.equal(devChannelEnabled('claude --dangerously-load-development-channels server:your-attention'), true);
    assert.equal(devChannelEnabled('claude --resume --dangerously-load-development-channels=server:other,server:your-attention'), true);
  });

  it('is off without the flag, with another server, or with the flag left without a value', () => {
    assert.equal(devChannelEnabled('claude'), false);
    assert.equal(devChannelEnabled('claude --dangerously-load-development-channels=server:other'), false);
    assert.equal(devChannelEnabled('claude --dangerously-load-development-channels'), false);
    assert.equal(devChannelEnabled('claude --dangerously-load-development-channels=plugin:x@y'), false);
  });

  it('says nothing when it cannot read a command line, so no page claims the channel is off', () => {
    assert.equal(devChannelEnabled(undefined), undefined);
  });
});
