import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { offerPin, type PinApi, type Terminal } from '../../src/node/pin-prompt.ts';

function fake(answers: string[], status: { set: boolean; neverAsk: boolean } = { set: false, neverAsk: false }) {
  const said: string[] = [];
  const hidden: string[] = [];
  const calls: string[] = [];
  const t: Terminal = {
    async ask(q) { said.push(q); return answers.shift() ?? ''; },
    async askHidden(q) { hidden.push(q); return answers.shift() ?? ''; },
    say(text) { said.push(text); },
    close() {},
  };
  const api: PinApi = {
    async status() { return { ...status, lockedUntil: null }; },
    async set(pin) { calls.push(`set ${pin}`); },
    async clear() { calls.push('clear'); },
    async neverAsk() { calls.push('never'); },
  };
  return { t, api, said, hidden, calls };
}

describe('the PIN question at start', () => {
  it('sets a PIN typed twice, hidden, and never prints it', async () => {
    const f = fake(['y', '2468', '2468']);
    assert.equal(await offerPin(f.t, f.api), 'set');
    assert.deepEqual(f.calls, ['set 2468']);
    assert.equal(f.hidden.length, 2);
    assert.equal(f.said.join('\n').includes('2468'), false);
  });

  it('asks again when the two PINs differ or are not 4 digits', async () => {
    const f = fake(['y', '12', '2468', '1357', '2468', '2468']);
    assert.equal(await offerPin(f.t, f.api), 'set');
    assert.deepEqual(f.calls, ['set 2468']);
    assert.match(f.said.join('\n'), /4 digits/);
    assert.match(f.said.join('\n'), /differ/);
  });

  it('skips with an empty answer, and stores "never" for n', async () => {
    const skip = fake(['']);
    assert.equal(await offerPin(skip.t, skip.api), 'skipped');
    assert.deepEqual(skip.calls, []);
    const never = fake(['n']);
    assert.equal(await offerPin(never.t, never.api), 'never');
    assert.deepEqual(never.calls, ['never']);
  });

  it('asks nothing when the inbox has a PIN or the person said never', async () => {
    for (const status of [{ set: true, neverAsk: false }, { set: false, neverAsk: true }]) {
      const f = fake([], status);
      assert.equal(await offerPin(f.t, f.api), 'not asked');
      assert.deepEqual(f.said, []);
    }
  });
});
