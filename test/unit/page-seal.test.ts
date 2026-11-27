// web/sealed.js seals in the page and in the terminal client. A large value must seal, and only the private key opens it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { seal } from '../../web/sealed.js';

describe('the page seals a secret', () => {
  it('seals a value of a megabyte, which one spread into String.fromCharCode would overflow', async () => {
    const keys = await newSealKeys();
    const value = 'x'.repeat(1024 * 1024);
    const sealed = await seal(keys.publicKey, value);
    assert.equal(await openSealed(keys.privateKey, sealed), value);
  });
});
