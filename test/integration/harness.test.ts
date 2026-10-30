// The harness ends what a test starts, even when the test fails before its own cleanup, so `node --test` can exit.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { start } from './harness.ts';
import { startTui } from './tui-pty.ts';

describe('the test harness', () => {
  it('ends every stream a test opened when the inbox stops', async () => {
    const h = await start();
    const agent = new Client({ url: h.server.url, token: h.agentToken });
    const { ended } = h.listen(agent, 's-left-open');
    await h.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([ended.then(() => 'ended'), new Promise((r) => { timer = setTimeout(() => r('still retrying'), 3000); })]);
    clearTimeout(timer);
    assert.equal(outcome, 'ended');
  });
});

describe('the terminal client helper', () => {
  it('stops a client twice after it quits, and a write to its closed input raises no error', async () => {
    const h = await start();
    const t = startTui({ url: h.server.url, token: h.server.ownerToken });
    try {
      await t.waitFor('Your attention');
      t.send('q');
      // A pipe whose reader is gone fails the write later, as an error event on the stream.
      assert.ok(t.child.stdin!.listenerCount('error') > 0, 'the input stream handles its own errors');
      await t.stop();
    } finally {
      await t.stop();
      await h.stop();
    }
  });
});
