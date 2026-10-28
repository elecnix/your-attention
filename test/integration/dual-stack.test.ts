// A laptop inbox answers on IPv4 and IPv6, so a phone reaches it even when a VPN routes the LAN's IPv4 elsewhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { serve } from '../../src/node/server.ts';

const hasV6 = Object.values(os.networkInterfaces()).flat().some((i) => i?.family === 'IPv6' && i.internal);

describe('a laptop inbox on every interface', () => {
  it('answers on IPv4 and IPv6, and lists IPv6 addresses for a phone', { skip: !hasV6 && 'this machine has no IPv6' }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-v6-'));
    const server = await serve({ port: 0, host: '::', home, mdns: false, watch: false, log: () => {} });
    try {
      const port = new URL(server.url).port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/info`)).status, 200);
      assert.equal((await fetch(`http://[::1]:${port}/v1/info`)).status, 200);
      const owner = fs.readFileSync(path.join(home, 'owner-token'), 'utf8').trim();
      const { addresses } = (await (await fetch(`${server.url}/v1/addresses`, { headers: { authorization: `Bearer ${owner}` } })).json()) as { addresses: string[] };
      assert.match(addresses[0] ?? '', /\.local:\d+$/);
      // Only a LAN interface's address counts: the inbox leaves tunnels and bridges out.
      const globalV6 = Object.entries(os.networkInterfaces())
        .filter(([iface]) => /^(en|eth|wlan|wl)/i.test(iface))
        .some(([, list]) => (list ?? []).some((i) => i.family === 'IPv6' && !i.internal && !/^fe80/i.test(i.address)));
      if (globalV6) assert.ok(addresses.some((a) => /^http:\/\/\[[0-9a-f:]+\]:\d+$/.test(a)), addresses.join(' '));
    } finally {
      await server.close();
    }
  });
});
