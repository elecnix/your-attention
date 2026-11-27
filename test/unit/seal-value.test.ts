// A source seals a value in Node the way the page seals one in the browser, so the session opens either alike.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSealed, newSealKeys, openSealed, sealValue } from '../../src/core/sealed.ts';
import { seal as pageSeal } from '../../web/sealed.js';

describe('sealing a value outside the page', () => {
  it('opens with the session key that asked for it', async () => {
    const { publicKey, privateKey } = await newSealKeys();
    const sealed = await sealValue(publicKey, 'postgres://u:p@db/x');
    assert.ok(isSealed(sealed));
    assert.equal(await openSealed(privateKey, sealed), 'postgres://u:p@db/x');
  });

  it('gives the same format as the page', async () => {
    const { publicKey } = await newSealKeys();
    const ours = await sealValue(publicKey, 'v');
    const page = await pageSeal(publicKey, 'v');
    assert.deepEqual(Object.keys(ours).sort(), Object.keys(page).sort());
    assert.equal(ours.alg, page.alg);
  });

  it('never holds the value in the clear', async () => {
    const { publicKey } = await newSealKeys();
    const sealed = await sealValue(publicKey, 'needle-in-the-hay');
    assert.ok(!JSON.stringify(sealed).includes('needle'));
  });
});
