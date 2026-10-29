// The terminal client acts as the owner. It prefers the owner pairing in owner.json, and on a machine paired only as an
// agent it says how to pair as owner without replacing the agent's pairing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { notOwnerAdvice } from '../../src/client.ts';
import { ownerConfig } from '../../src/tui/api.ts';

const home = (files: Record<string, unknown>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-tui-config-'));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  return dir;
};

describe('terminal client inbox', () => {
  it('uses the owner pairing before the agent pairing', () => {
    const dir = home({ 'owner.json': { url: 'https://inbox.example.com/i/abc/', token: 'own' }, 'client.json': { url: 'https://inbox.example.com/i/abc', token: 'agt' } });
    const c = ownerConfig({}, dir);
    assert.ok(typeof c !== 'string');
    assert.equal(c.token, 'own');
    assert.equal(c.url, 'https://inbox.example.com/i/abc');
    assert.equal(c.source, path.join(dir, 'owner.json'));
  });

  it('says an agent pairing cannot open the inbox, and how to pair as owner beside it', () => {
    const advice = notOwnerAdvice('https://inbox.example.com/i/abc');
    assert.match(advice, /paired with https:\/\/inbox\.example\.com\/i\/abc as an agent/);
    assert.match(advice, /your-attention pair https:\/\/inbox\.example\.com\/i\/abc --role owner/);
    assert.match(advice, /keeps the agent pairing/);
  });
});
