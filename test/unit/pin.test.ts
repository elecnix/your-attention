import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStorage } from '../../src/core/storage.ts';
import { FIRST_LOCKOUT_MS, MAX_LOCKOUT_MS, PIN_ITERATIONS, PIN_TRIES, PinLock, UNLOCK_IDLE_MS, newPinKey, pinKey } from '../../src/core/pin.ts';
import { sha256 } from '../../src/core/crypto.ts';
import * as page from '../../web/pin-key.js';

/** A client derives the key it sends with the salt and iterations of the PIN that is set. */
const keyed = (lock: PinLock) => Object.assign(lock, {
  unlockPin: async (p: string, owner: string) => lock.unlock(await pinKey(p, lock.status().salt ?? '', lock.status().iterations), owner),
});

function setup() {
  let t = 1_000_000;
  const store = new MemoryStorage();
  const pin = keyed(new PinLock(store, () => t, 1000));
  const key = (p: string) => pinKey(p, pin.status().salt ?? '', pin.status().iterations);
  return { store, pin, key, tick: (ms: number) => { t += ms; }, now: () => t };
}

describe('PIN keys', () => {
  it('the page and the inbox derive the same key, salted, and never keep the PIN', async () => {
    const a = await newPinKey('1234', 1000);
    const b = await newPinKey('1234', 1000);
    assert.notEqual(a.salt, b.salt, 'each key has its own salt');
    assert.notEqual(a.key, b.key);
    assert.equal(await page.pinKey('1234', a.salt, 1000), a.key);
    assert.equal((await page.newPinKey('1234', 1000)).key.length, 64);
    assert.equal(PIN_ITERATIONS, 800_000);
  });

  it('the page derives the same key without Web Crypto, as on a plain-HTTP address from another machine', async () => {
    const salt = '00112233445566778899aabbccddeeff';
    assert.equal(page.pinKeyWithoutWebCrypto('2468', salt, 1000), await pinKey('2468', salt, 1000));
    assert.equal(page.pinKeyWithoutWebCrypto('0000', salt, 1), await pinKey('0000', salt, 1));
    // RFC 7914's PBKDF2-HMAC-SHA256 vector: P = "passwd", S = "salt", c = 1, first 32 bytes.
    assert.equal(page.pinKeyWithoutWebCrypto('passwd', '73616c74', 1), '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc');
  });

  it('stores the SHA-256 of the key, so a stolen store does not unlock', async () => {
    const { pin, store, key } = setup();
    const k = await newPinKey('2468', 1000);
    await pin.setKey(k);
    const stored = JSON.stringify(store.get('meta', 'pin'));
    assert.equal(stored.includes(k.key), false);
    assert.ok(stored.includes(await sha256(k.key)));
    assert.equal(await key('2468'), k.key);
    assert.equal((await pin.unlock(await sha256(k.key), 'o')).ok, false);
    assert.equal((await pin.unlock(k.key, 'o')).ok, true);
  });

  it('refuses anything but four digits, and a key it cannot check', async () => {
    const { pin } = setup();
    for (const bad of ['123', '12345', 'abcd', '12 4', '']) await assert.rejects(pin.set(bad), /4 digits/);
    const good = await newPinKey('1234', 1000);
    await assert.rejects(pin.setKey({ ...good, key: 'x' }), /key must be/);
    await assert.rejects(pin.setKey({ ...good, salt: 'short' }), /salt must be/);
    await assert.rejects(pin.setKey({ ...good, iterations: 10 }), /iterations must be 1000/);
  });

  it('hands out the count for a new PIN apart from the count of the PIN that is set', async () => {
    const { pin, store } = setup();
    const old = await newPinKey('2468', 500);
    store.put('meta', 'pin', { key: await sha256(old.key), salt: old.salt, iterations: 500, setAt: 1 });
    assert.equal(pin.status().iterations, 500);
    assert.equal(pin.status().newIterations, 1000);
    await pin.setKey(await newPinKey('1357', pin.status().newIterations));
    assert.equal(pin.status().iterations, 1000);
  });

  it('keeps a PIN that an older laptop inbox stored as the derived key itself', async () => {
    const { pin, store } = setup();
    const k = await newPinKey('2468', 800_000);
    store.put('meta', 'pin', { hash: k.key, salt: k.salt, iterations: 800_000, setAt: 1 });
    assert.equal(pin.status().set, true);
    assert.equal(pin.status().salt, k.salt);
    assert.equal(pin.status().iterations, 800_000, 'the client derives with the stored count');
    assert.equal((await pin.unlockPin('1111', 'o')).ok, false);
    assert.equal((await pin.unlockPin('2468', 'o')).ok, true);
  });
});

describe('the PIN lock', () => {
  it('starts with no PIN, and remembers "never ask"', async () => {
    const { pin, store } = setup();
    assert.deepEqual(pin.status(), { set: false, salt: null, iterations: 1000, newIterations: 1000, neverAsk: false, lockedUntil: null, triesLeft: PIN_TRIES });
    pin.setNeverAsk(true);
    assert.equal(new PinLock(store, Date.now, 1000).status().neverAsk, true, 'the choice is in storage');
  });

  it('unlocks with the right PIN and gives a token bound to the owner token', async () => {
    const { pin, store } = setup();
    await pin.set('2468');
    const r = await pin.unlockPin('2468', 'owner1');
    assert.equal(r.ok, true);
    const token = r.ok ? r.token : '';
    assert.ok(await pin.verifyUnlock(token, 'owner1'));
    assert.equal(await pin.verifyUnlock(token, 'owner2'), undefined, 'another token cannot use it');
    assert.equal(await pin.verifyUnlock(`${token}x`, 'owner1'), undefined);
    assert.equal(await pin.verifyUnlock(undefined, 'owner1'), undefined);
    assert.equal(JSON.stringify(store.list('meta')).includes(token.split('.')[1] ?? '-'), false, 'the store keeps a hash of the token');
  });

  it('drops an unlock token after 12 idle hours, and keeps one in use', async () => {
    const { pin, tick } = setup();
    await pin.set('2468');
    const r = await pin.unlockPin('2468', 'o');
    const token = r.ok ? r.token : '';
    tick(UNLOCK_IDLE_MS - 1000);
    assert.ok(await pin.verifyUnlock(token, 'o'), 'use resets the idle clock');
    tick(UNLOCK_IDLE_MS - 1000);
    assert.ok(await pin.verifyUnlock(token, 'o'));
    tick(UNLOCK_IDLE_MS + 1);
    assert.equal(await pin.verifyUnlock(token, 'o'), undefined);
  });

  it('locks out after 5 wrong tries, doubling the wait, and keeps the count in storage', async () => {
    const { pin, store, tick, now } = setup();
    await pin.set('2468');
    for (let i = 1; i < PIN_TRIES; i++) {
      const r = await pin.unlockPin('0000', 'o');
      assert.deepEqual(r, { ok: false, triesLeft: PIN_TRIES - i });
    }
    const fifth = await pin.unlockPin('0000', 'o');
    assert.deepEqual(fifth, { ok: false, lockedUntil: now() + FIRST_LOCKOUT_MS });
    // A restart reads the lockout back, and even the right PIN waits.
    const again = keyed(new PinLock(store, now, 1000));
    assert.deepEqual(await again.unlockPin('2468', 'o'), { ok: false, lockedUntil: now() + FIRST_LOCKOUT_MS });
    tick(FIRST_LOCKOUT_MS);
    for (let i = 0; i < PIN_TRIES; i++) await again.unlockPin('0000', 'o');
    assert.equal(again.status().lockedUntil, now() + 2 * FIRST_LOCKOUT_MS, 'the second lockout is twice as long');
    tick(2 * FIRST_LOCKOUT_MS);
    assert.equal((await again.unlockPin('2468', 'o')).ok, true);
    assert.deepEqual({ ...again.status(), salt: null }, { set: true, salt: null, iterations: 1000, newIterations: 1000, neverAsk: false, lockedUntil: null, triesLeft: PIN_TRIES }, 'the right PIN clears the count');
  });

  it('caps the lockout at a day', async () => {
    const { pin, tick, now } = setup();
    await pin.set('2468');
    for (let round = 0; round < 15; round++) {
      for (let i = 0; i < PIN_TRIES; i++) await pin.unlockPin('0000', 'o');
      tick(MAX_LOCKOUT_MS);
    }
    for (let i = 0; i < PIN_TRIES; i++) await pin.unlockPin('0000', 'o');
    assert.equal(pin.status().lockedUntil, now() + MAX_LOCKOUT_MS);
  });

  it('counts tries that arrive at once, before the slow hash finishes', async () => {
    const { pin } = setup();
    await pin.set('2468');
    const results = await Promise.all(Array.from({ length: 20 }, () => pin.unlockPin('0000', 'o')));
    assert.equal(results.filter((r) => !r.ok && 'triesLeft' in r).length, PIN_TRIES - 1);
    assert.equal(results.filter((r) => !r.ok && 'lockedUntil' in r).length, 20 - (PIN_TRIES - 1));
  });

  it('ends every unlock token when the PIN changes or goes, and tells the listeners', async () => {
    const { pin } = setup();
    let dropped = 0;
    pin.onChange(() => { dropped++; });
    await pin.set('2468');
    const a = await pin.unlockPin('2468', 'o');
    const token = a.ok ? a.token : '';
    await pin.set('1357');
    assert.equal(await pin.verifyUnlock(token, 'o'), undefined);
    const b = await pin.unlockPin('1357', 'o');
    pin.clear();
    assert.equal(await pin.verifyUnlock(b.ok ? b.token : '', 'o'), undefined);
    assert.equal(pin.status().set, false);
    assert.equal(dropped, 2 + 1, 'set, set, clear');
  });

  it('never brings back a token that a PIN change dropped while a request checked it', async () => {
    const { pin, tick } = setup();
    await pin.set('2468');
    const r = await pin.unlockPin('2468', 'o');
    const token = r.ok ? r.token : '';
    tick(5 * 60_000);
    const checking = pin.verifyUnlock(token, 'o');
    pin.clear();
    assert.equal(await checking, undefined);
    assert.equal(pin.live(token.split('.')[0]), false);
  });

  it('ends one tab\'s unlock token on lock', async () => {
    const { pin } = setup();
    await pin.set('2468');
    const a = await pin.unlockPin('2468', 'o');
    const b = await pin.unlockPin('2468', 'o');
    await pin.lock(a.ok ? a.token : '');
    assert.equal(await pin.verifyUnlock(a.ok ? a.token : '', 'o'), undefined);
    assert.ok(await pin.verifyUnlock(b.ok ? b.token : '', 'o'));
  });

  it('a new PIN clears the lockout', async () => {
    const { pin } = setup();
    await pin.set('2468');
    for (let i = 0; i < PIN_TRIES; i++) await pin.unlockPin('0000', 'o');
    assert.ok(pin.status().lockedUntil);
    await pin.set('1357');
    assert.equal(pin.status().lockedUntil, null);
    assert.equal((await pin.unlockPin('1357', 'o')).ok, true);
  });

  it('sweeps idle unlock tokens out of storage', async () => {
    const { pin, store, tick } = setup();
    await pin.set('2468');
    await pin.unlockPin('2468', 'o');
    tick(UNLOCK_IDLE_MS + 1);
    pin.sweep();
    assert.equal(store.list<{ key?: string }>('meta').filter((m) => m?.key?.startsWith('unlock:')).length, 0);
  });
});
