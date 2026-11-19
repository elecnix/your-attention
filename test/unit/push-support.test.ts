// Whether this page can push, and the words it gives when it cannot.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isIos, pushSupport } from '../../web/push.js';

const ok = { secure: true, ios: false, standalone: false, hasPush: true, hasNotification: true, permission: 'default' };

describe('where the page can push', () => {
  it('can on an https address, or localhost, in a browser that has push', () => {
    assert.deepEqual(pushSupport(ok), { ok: true, mode: 'push' });
    assert.deepEqual(pushSupport({ ...ok, permission: 'granted' }), { ok: true, mode: 'push' });
  });

  it('says it needs an https address on a plain http page, before anything else', () => {
    assert.deepEqual(pushSupport({ ...ok, secure: false, hasPush: false, hasNotification: false }), { ok: false, reason: 'needs an https address' });
    assert.deepEqual(pushSupport({ ...ok, secure: false, ios: true }), { ok: false, reason: 'needs an https address' });
  });

  it('says to add the page to the Home Screen first on an iPhone outside an installed app', () => {
    const iphone = { ...ok, ios: true, hasPush: false, hasNotification: false };
    assert.deepEqual(pushSupport(iphone), { ok: false, reason: 'add this page to your Home Screen first' });
    assert.deepEqual(pushSupport({ ...iphone, hasPush: true, hasNotification: true }), { ok: false, reason: 'add this page to your Home Screen first' });
    assert.deepEqual(pushSupport({ ...iphone, standalone: true, hasPush: true, hasNotification: true }), { ok: true, mode: 'push' }, 'installed, it can');
  });

  it('says the browser blocks notifications when the person denied them', () => {
    assert.deepEqual(pushSupport({ ...ok, permission: 'denied' }), { ok: false, reason: 'the browser blocks notifications' });
  });

  it('falls back to notifications while the page is open where the browser has no push', () => {
    assert.deepEqual(pushSupport({ ...ok, hasPush: false }), { ok: true, mode: 'page' });
    assert.deepEqual(pushSupport({ ...ok, hasPush: false, permission: 'denied' }), { ok: false, reason: 'the browser blocks notifications' });
  });

  it('says so when the browser has neither', () => {
    assert.deepEqual(pushSupport({ ...ok, hasPush: false, hasNotification: false }), { ok: false, reason: 'this browser cannot show notifications' });
  });

  it('knows an iPhone, an iPad and an iPad that says it is a Mac', () => {
    assert.equal(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', 5), true);
    assert.equal(isIos('Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15', 5), true);
    assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5), true, 'iPadOS Safari asks for the desktop site');
    assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 0), false, 'a Mac has no touch screen');
    assert.equal(isIos('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36', 0), false);
    assert.equal(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0 Mobile Safari/537.36', 5), false);
  });
});
