// `loadConfig`: which inbox a client uses, and that a file it cannot use is the same as no file at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client, loadConfig } from '../../src/client.ts';

let home = '';
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-config-')); });
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  delete process.env['YOUR_ATTENTION_URL'];
  delete process.env['YOUR_ATTENTION_TOKEN'];
});

/** Write one file in the home, and answer the config it resolves to. */
const withFile = (name: string, text: string) => {
  fs.writeFileSync(path.join(home, name), text);
  return loadConfig(home);
};

describe('the inbox a client uses', () => {
  it('takes the environment before any file', () => {
    withFile('client.json', '{"url":"http://paired","token":"t1"}');
    process.env['YOUR_ATTENTION_URL'] = 'http://env';
    process.env['YOUR_ATTENTION_TOKEN'] = 't2';
    assert.deepEqual(loadConfig(home), { url: 'http://env', token: 't2' });
  });

  it('takes an agent pairing, then the inbox this machine serves', () => {
    assert.deepEqual(withFile('client.json', '{"url":"http://paired","token":"t1"}'), { url: 'http://paired', token: 't1' });
    fs.rmSync(path.join(home, 'client.json'));
    fs.writeFileSync(path.join(home, 'server.json'), '{"url":"http://local"}');
    withFile('agent-token', 'ta');
    assert.deepEqual(loadConfig(home), { url: 'http://local', token: 'ta' });
  });

  it('answers nothing for a file it cannot use, rather than failing on it', () => {
    // Each of these parsed to something a client would have failed on: a missing field, a URL of 42, `undefined.replace`.
    for (const text of ['{', 'null', '42', '{"url":42}', '{}', '{"url":"http://x"}', '{"url":"","token":"t"}', '']) {
      assert.equal(withFile('client.json', text), undefined, `client.json holding ${JSON.stringify(text)}`);
    }
    assert.equal(withFile('server.json', '{'), undefined, 'a server.json that does not parse');
  });
});

describe('a reply this client does not trust', () => {
  it('answers a count and a list of ids, whatever the address sends', async () => {
    const { Client } = await import('../../src/client.ts');
    const cases: [unknown, { unread: number; cards: string[] }][] = [
      [{ unread: 2 }, { unread: 2, cards: [] }],
      [{ unread: 2, cards: 'nope' }, { unread: 2, cards: [] }],
      [{ cards: ['a', 7, 'b'] }, { unread: 2, cards: ['a', 'b'] }],
      [{ unread: 'many', cards: ['a'] }, { unread: 1, cards: ['a'] }],
      [null, { unread: 0, cards: [] }],
    ];
    for (const [reply, expected] of cases) {
      const client = new Client({ url: 'http://inbox.test', token: 't' });
      // A stand-in for the route, so the test is about what the client does with a reply rather than the route's shape.
      (client as unknown as { call: unknown }).call = async () => reply;
      assert.deepEqual(await client.unread(), expected, `reply ${JSON.stringify(reply)}`);
    }
  });
});

describe('a pairing file that carries more than an address', () => {
  it('keeps one, drops what a client would fail on, and never crashes it', () => {
    const withUrls = (urls: unknown) => withFile('client.json', JSON.stringify({ url: 'http://a', token: 't', urls }));
    for (const bad of ['nope', [42], [null], {}]) {
      const config = withUrls(bad);
      assert.deepEqual(config, { url: 'http://a', token: 't' }, `urls holding ${JSON.stringify(bad)}`);
      assert.doesNotThrow(() => new Client(config), 'a client built from it');
    }
    assert.deepEqual(withUrls(['http://b', 42, '']), { url: 'http://a', token: 't', urls: ['http://b'] }, 'the strings it can use');
  });
});
