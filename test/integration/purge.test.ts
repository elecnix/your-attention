// The laptop inbox purges a card nobody answered for 30 days, with its file on disk, from its one-second alarm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PURGE_AFTER_MS } from '../../src/core/inbox.ts';
import { serve } from '../../src/node/server.ts';

describe('the laptop alarm', () => {
  it('purges an old card and deletes its file from disk', async (t) => {
    // Only the clock is faked, so the server's one-second interval still runs.
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-purge-'));
    const server = await serve({ host: '127.0.0.1', port: 0, home, mdns: false, watch: false, log: () => {} });
    try {
      const src = `data:text/markdown;base64,${Buffer.from('# notes').toString('base64')}`;
      await server.inbox.postCardWithFiles({ token: 'ta', role: 'agent' }, { id: 'old', agent: 's1', title: 'q', attachments: [{ src, name: 'notes.md' }] });
      const files = path.join(home, 'files');
      assert.equal(fs.readdirSync(files).length, 2, 'the file and its type');
      t.mock.timers.tick(PURGE_AFTER_MS);
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) {
        await new Promise((r) => setTimeout(r, 50));
        gone = fs.readdirSync(files).length === 0;
      }
      assert.ok(gone, 'the file is deleted');
      assert.throws(() => server.inbox.getCard('old'), /unknown card/);
    } finally {
      await server.close();
    }
  });
});
