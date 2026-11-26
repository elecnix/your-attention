import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addressTag, newAddress, validAddress } from '../../src/cloudflare/address.ts';

describe('a hosted inbox address', () => {
  it('is 32 hex digits, 20 of them random and 12 the signature over those 20', async () => {
    const id = await newAddress('s3cret');
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(id.slice(20), await addressTag('s3cret', id.slice(0, 20)), 'the last 12 digits sign the first 20');
    assert.notEqual(await newAddress('s3cret'), id, 'two addresses differ');
  });

  it('is valid only with the secret that signed it', async () => {
    const id = await newAddress('s3cret');
    assert.equal(await validAddress('s3cret', id), true);
    assert.equal(await validAddress('another', id), false, 'another secret signs a different tag');
    assert.equal(await validAddress('s3cret', `${id.slice(0, 20)}${'0'.repeat(12)}`), false, 'a made-up tag is refused');
  });

  it('is refused when it is not 32 hex digits, before any signature is computed', async () => {
    for (const id of ['', 'abc', 'z'.repeat(32), `${'0'.repeat(32)}ff`]) assert.equal(await validAddress('s3cret', id), false);
  });
});
