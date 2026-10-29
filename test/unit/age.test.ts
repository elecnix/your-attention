import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardAge } from '../../web/age.js';

const MIN = 60_000;
describe('card age', () => {
  it('reads as a rough age: minutes, then hours and minutes, then days and hours', () => {
    const cases: [number, string][] = [
      [20_000, 'just now'],
      [3 * MIN, '3 min ago'],
      [14 * MIN, '15 min ago'],
      [47 * MIN, '45 min ago'],
      [58 * MIN, '1 h ago'],
      [62 * MIN, '1 h ago'],
      [67 * MIN, '1 h 10 min ago'],
      [(4 * 60 + 31) * MIN, '4 h 30 min ago'],
      [(5 * 60 + 56) * MIN, '6 h ago'],
      [(26 * 60 + 10) * MIN, '1 d 2 h ago'],
      [(3 * 24 * 60 + 20) * MIN, '3 d ago'],
    ];
    for (const [ms, want] of cases) assert.equal(cardAge(ms), want, `${ms / MIN} min`);
  });

  it('reads a time in the future, from a clock that runs behind, as just now', () => {
    assert.equal(cardAge(-5 * MIN), 'just now');
  });
});
