import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStorage } from '../../src/core/storage.ts';
import { FIRST_LOCKOUT_MS, MAX_LOCKOUT_MS, PIN_TRIES, PinLock, UNLOCK_IDLE_MS, hashPin, verifyPin } from '../../src/core/pin.ts';

function setup() {
  let t = 1_000_000;
  const store = new MemoryStorage();
  const pin = new PinLock(store, () => t, 1000);
  return { store, pin, tick: (ms: number) => { t += ms; }, now: () => t };
}

describe('PIN hashing', () => {
  it('stores a salted PBKDF2 hash that verifies the PIN and no other', async () => {
    const a = await hashPin('1234', 1000);
    const b = await hashPin('1234', 1000);
    assert.notEqual(a.salt, b.salt, 'each hash has its own salt');
    assert.notEqual(a.hash, b.hash);
    assert.equal(a.iterations, 1000);
    assert.equal(JSON.stringify(a).includes('1234'), false);
    assert.equal(await verifyPin('1234', a), true);
    assert.equal(await verifyPin('1235', a), false);
  });

  it('refuses anything but four digits', async () => {
    const { pin } = setup();
    for (const bad of ['123', '12345', 'abcd', '12 4', '']) await assert.rejects(pin.set(bad), /4 digits/);
  });
});

describe('the PIN lock', () => {
  it('starts with no PIN, and remembers "never ask"', async () => {
    const { pin, store } = setup();
    assert.deepEqual(pin.status(), { set: false, neverAsk: false, lockedUntil: null, triesLeft: PIN_TRIES });
    pin.setNeverAsk(true);
    assert.equal(new PinLock(store, Date.now, 1000).status().neverAsk, true, 'the choice is in storage');
  });

  it('unlocks with the right PIN and gives a token bound to the owner token', async () => {
    const { pin, store } = setup();
    await pin.set('2468');
    const r = await pin.unlock('2468', 'owner1');
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
    const r = await pin.unlock('2468', 'o');
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
      const r = await pin.unlock('0000', 'o');
      assert.deepEqual(r, { ok: false, triesLeft: PIN_TRIES - i });
    }
    const fifth = await pin.unlock('0000', 'o');
    assert.deepEqual(fifth, { ok: false, lockedUntil: now() + FIRST_LOCKOUT_MS });
    // A restart reads the lockout back, and even the right PIN waits.
    const again = new PinLock(store, now, 1000);
    assert.deepEqual(await again.unlock('2468', 'o'), { ok: false, lockedUntil: now() + FIRST_LOCKOUT_MS });
    tick(FIRST_LOCKOUT_MS);
    for (let i = 0; i < PIN_TRIES; i++) await again.unlock('0000', 'o');
    assert.equal(again.status().lockedUntil, now() + 2 * FIRST_LOCKOUT_MS, 'the second lockout is twice as long');
    tick(2 * FIRST_LOCKOUT_MS);
    assert.equal((await again.unlock('2468', 'o')).ok, true);
    assert.deepEqual(again.status(), { set: true, neverAsk: false, lockedUntil: null, triesLeft: PIN_TRIES }, 'the right PIN clears the count');
  });

  it('caps the lockout at a day', async () => {
    const { pin, tick, now } = setup();
    await pin.set('2468');
    for (let round = 0; round < 15; round++) {
      for (let i = 0; i < PIN_TRIES; i++) await pin.unlock('0000', 'o');
      tick(MAX_LOCKOUT_MS);
    }
    for (let i = 0; i < PIN_TRIES; i++) await pin.unlock('0000', 'o');
    assert.equal(pin.status().lockedUntil, now() + MAX_LOCKOUT_MS);
  });

  it('counts tries that arrive at once, before the slow hash finishes', async () => {
    const { pin } = setup();
    await pin.set('2468');
    const results = await Promise.all(Array.from({ length: 20 }, () => pin.unlock('0000', 'o')));
    assert.equal(results.filter((r) => !r.ok && 'triesLeft' in r).length, PIN_TRIES - 1);
    assert.equal(results.filter((r) => !r.ok && 'lockedUntil' in r).length, 20 - (PIN_TRIES - 1));
  });

  it('ends every unlock token when the PIN changes or goes, and tells the listeners', async () => {
    const { pin } = setup();
    let dropped = 0;
    pin.onChange(() => { dropped++; });
    await pin.set('2468');
    const a = await pin.unlock('2468', 'o');
    const token = a.ok ? a.token : '';
    await pin.set('1357');
    assert.equal(await pin.verifyUnlock(token, 'o'), undefined);
    const b = await pin.unlock('1357', 'o');
    pin.clear();
    assert.equal(await pin.verifyUnlock(b.ok ? b.token : '', 'o'), undefined);
    assert.equal(pin.status().set, false);
    assert.equal(dropped, 2 + 1, 'set, set, clear');
  });

  it('never brings back a token that a PIN change dropped while a request checked it', async () => {
    const { pin, tick } = setup();
    await pin.set('2468');
    const r = await pin.unlock('2468', 'o');
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
    const a = await pin.unlock('2468', 'o');
    const b = await pin.unlock('2468', 'o');
    await pin.lock(a.ok ? a.token : '');
    assert.equal(await pin.verifyUnlock(a.ok ? a.token : '', 'o'), undefined);
    assert.ok(await pin.verifyUnlock(b.ok ? b.token : '', 'o'));
  });

  it('a new PIN clears the lockout', async () => {
    const { pin } = setup();
    await pin.set('2468');
    for (let i = 0; i < PIN_TRIES; i++) await pin.unlock('0000', 'o');
    assert.ok(pin.status().lockedUntil);
    await pin.set('1357');
    assert.equal(pin.status().lockedUntil, null);
    assert.equal((await pin.unlock('1357', 'o')).ok, true);
  });

  it('sweeps idle unlock tokens out of storage', async () => {
    const { pin, store, tick } = setup();
    await pin.set('2468');
    await pin.unlock('2468', 'o');
    tick(UNLOCK_IDLE_MS + 1);
    pin.sweep();
    assert.equal(store.list<{ key?: string }>('meta').filter((m) => m?.key?.startsWith('unlock:')).length, 0);
  });
});
