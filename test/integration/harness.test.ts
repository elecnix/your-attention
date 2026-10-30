// The harness ends what a test starts, even when the test fails before its own cleanup, so `node --test` can exit.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { start } from './harness.ts';

describe('the test harness', () => {
  it('ends every stream a test opened when the inbox stops', async () => {
    const h = await start();
    const agent = new Client({ url: h.server.url, token: h.agentToken });
    const { ended } = h.listen(agent, 's-left-open');
    await h.stop();
    const outcome = await Promise.race([ended.then(() => 'ended'), new Promise((r) => setTimeout(() => r('still retrying'), 3000))]);
    assert.equal(outcome, 'ended');
  });
});
