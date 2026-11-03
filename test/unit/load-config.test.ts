// `loadConfig`: which inbox a client uses, and that a file it cannot use is the same as no file at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../../src/client.ts';

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
