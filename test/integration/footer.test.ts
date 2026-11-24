// `your-attention footer` prints the status-line segment from a real inbox: the count, one OSC 8 link per card in the
// page's queue order, `--max`, and silence with exit 0 when the inbox has gone or nothing waits.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli, serveForTest } from './harness.ts';

/** The exact bytes of one digit linking to a card. */
const link = (url: string, id: string, digit: number): string => `\x1b]8;;${url}/#card=${id}\x07${digit}\x1b]8;;\x07`;

describe('the footer segment from the command line', () => {
  it('prints the count and a link per card in queue order, and cuts the links to --max', async () => {
    const server = await serveForTest('ya-footer-');
    try {
      const agent = server.read('agent-token');
      await server.call(agent, 'POST', '/v1/cards', { id: 'later', agent: 'a', title: 'A card that can wait', priority: 'later' });
      await server.call(agent, 'POST', '/v1/cards', { id: 'now', agent: 'a', title: 'A card that cannot wait', priority: 'now' });
      const all = await runCli(server.env, 'footer');
      assert.equal(all.code, 0, all.stderr);
      assert.equal(all.stdout, `2 cards ${link(server.url, 'now', 1)} ${link(server.url, 'later', 2)}\n`);
      const one = await runCli(server.env, 'footer', '--max', '1');
      assert.equal(one.code, 0, one.stderr);
      assert.equal(one.stdout, `2 cards ${link(server.url, 'now', 1)}\n`);
      const none = await runCli(server.env, 'footer', '--max', '0');
      assert.equal(none.code, 0, none.stderr);
      assert.equal(none.stdout, '2 cards\n');
      const wrong = await runCli(server.env, 'footer', '--max', 'two');
      assert.equal(wrong.code, 2);
      assert.match(wrong.stderr, /--max takes a whole number of links/);
    } finally {
      await server.close();
    }
  });

  it('prints nothing and exits 0 for an inbox with no card waiting', async () => {
    const server = await serveForTest('ya-footer-');
    try {
      const r = await runCli(server.env, 'footer');
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '');
    } finally {
      await server.close();
    }
  });

  it('prints nothing and exits 0 when the inbox has gone', async () => {
    const server = await serveForTest('ya-footer-');
    const env = server.env;
    await server.close();
    const r = await runCli(env, 'footer');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
});
