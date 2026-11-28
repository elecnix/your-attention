// The page and the terminal client order their settings writes and the states they read with one shared module.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { settingsWrites } from '../../web/settings-writes.js';

/** A send whose writes wait until the test settles them, in the order the test chooses. */
function heldSend() {
  const held: { patch: Record<string, unknown>; ok: () => void; fail: () => void }[] = [];
  const send = (patch: Record<string, unknown>) => new Promise<void>((ok, reject) => held.push({ patch, ok, fail: () => reject(new Error('refused')) }));
  return { send, held };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('settingsWrites', () => {
  it('starts a write only after the one before it settled', async () => {
    const { send, held } = heldSend();
    const w = settingsWrites(send);
    void w.save({ groupBy: 'priority' });
    void w.save({ groupBy: 'agent' });
    await tick();
    assert.deepEqual(held.map((h) => h.patch), [{ groupBy: 'priority' }]);
    held[0]!.ok();
    await tick();
    assert.deepEqual(held.map((h) => h.patch), [{ groupBy: 'priority' }, { groupBy: 'agent' }]);
  });

  it('starts the next write after a write that failed', async () => {
    const { send, held } = heldSend();
    const w = settingsWrites(send);
    const first = w.save({ groupBy: 'priority' });
    void w.save({ groupBy: 'agent' });
    await tick();
    held[0]!.fail();
    await assert.rejects(first, /refused/);
    await tick();
    assert.equal(held.length, 2);
  });

  it('refuses the settings of a state whose request started before a write settled', async () => {
    const { send, held } = heldSend();
    const w = settingsWrites(send);
    const before = w.started();
    const write = w.save({ groupBy: 'priority' });
    await tick();
    const during = w.started();
    assert.equal(w.settingsCurrent(before), false);
    assert.equal(w.settingsCurrent(during), false);
    held[0]!.ok();
    await write;
    // The write settled, and both requests started before it did: their states may hold the old value.
    assert.equal(w.settingsCurrent(before), false);
    assert.equal(w.settingsCurrent(during), false);
    assert.equal(w.settingsCurrent(w.started()), true);
  });

  it('refuses a state whose request started before one already applied', () => {
    const w = settingsWrites(() => Promise.resolve());
    const older = w.started();
    const newer = w.started();
    assert.equal(w.newest(newer), true);
    assert.equal(w.newest(older), false);
    assert.equal(w.newest(w.started()), true);
  });
});
