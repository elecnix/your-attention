// Advertises an inbox over mDNS and finds it again on this host.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advertise, discover } from '../../src/adapters/mdns.ts';

describe('mDNS discovery', { skip: process.env['YOUR_ATTENTION_SKIP_MDNS'] === '1' && 'YOUR_ATTENTION_SKIP_MDNS is set' }, () => {
  it('finds the advertised inbox with its TXT record', async () => {
    const ad = advertise({ port: 48151, inboxId: 'test-inbox-1', name: `your-attention test ${process.pid}` });
    try {
      const found = await discover(2500);
      const mine = found.find((f) => f.txt['id'] === 'test-inbox-1');
      assert.ok(mine, `found: ${found.map((f) => f.name).join(', ') || 'nothing'}`);
      assert.equal(mine.port, 48151);
      assert.equal(mine.txt['v'], '1');
      assert.equal(mine.txt['pair'], '/v1/pair');
    } finally {
      await ad.stop();
    }
  });
});
