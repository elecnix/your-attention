// Grants: a secret the person approved for one agent, held in memory, with two clocks and a revocable case id
// (SPEC.md, "Secret grants").
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_IDLE_MS, Grants, MAX_UNTIL_MS } from '../../src/secrets/grant.ts';

const MIN = 60_000;
const T0 = 1_760_000_000_000;

/** A store whose clock the test moves, so both clocks can be exercised without waiting. */
function store(): { grants: Grants; at: (ms: number) => void } {
  let now = T0;
  const grants = new Grants(() => now);
  return { grants, at: (ms) => { now = ms; } };
}

describe('a secret grant', () => {
  it('hands the value back to the agent that was approved, and to no other', () => {
    const { grants } = store();
    grants.hold({ name: 'SPLITWISE_API_KEY', agent: 'pi:s1', value: 'v1', until: T0 + 60 * MIN });
    assert.equal(grants.take('pi:s1', 'SPLITWISE_API_KEY'), 'v1');
    assert.equal(grants.take('pi:s2', 'SPLITWISE_API_KEY'), undefined, 'another session did not ask for it');
    assert.equal(grants.take('pi:s1', 'YNAB_ACCESS_TOKEN'), undefined, 'another secret was never approved');
  });

  it('restarts its idle window on each use, so an active session is never re-asked', () => {
    const { grants, at } = store();
    grants.hold({ name: 'K', agent: 'pi:s1', value: 'v', until: T0 + 24 * 60 * MIN });
    at(T0 + 10 * MIN);
    assert.equal(grants.take('pi:s1', 'K'), 'v', 'used again inside the window');
    at(T0 + 20 * MIN);
    assert.equal(grants.take('pi:s1', 'K'), 'v', 'ten minutes after the last use, not after approval');
    at(T0 + 20 * MIN + DEFAULT_IDLE_MS - 1);
    assert.equal(grants.take('pi:s1', 'K'), 'v', 'one millisecond inside a window that started at the last use');
    at(T0 + 20 * MIN + 2 * DEFAULT_IDLE_MS);
    assert.equal(grants.take('pi:s1', 'K'), undefined, 'nothing used it for a whole window');
  });

  it('dies at the ceiling even when something touched it a moment before', () => {
    const { grants, at } = store();
    // The idle window is longer than the gap, so only the ceiling can end this grant.
    grants.hold({ name: 'K', agent: 'pi:s1', value: 'v', until: T0 + 30 * MIN, idleMs: 60 * MIN });
    at(T0 + 29 * MIN);
    assert.equal(grants.take('pi:s1', 'K'), 'v');
    at(T0 + 30 * MIN);
    assert.equal(grants.take('pi:s1', 'K'), undefined, 'using a grant cannot push the ceiling later');
  });

  it('is killed by its case id, and takes effect on the next take', () => {
    const { grants } = store();
    const grant = grants.hold({ name: 'K', agent: 'pi:s1', value: 'v', until: T0 + 60 * MIN });
    assert.equal(grants.revoke('nope'), false, 'an unknown case id revokes nothing');
    assert.equal(grants.revoke(grant.caseId), true);
    assert.equal(grants.take('pi:s1', 'K'), undefined, 'revocation does not wait for the next expiry');
  });

  it('replaces an earlier grant for the same name, and its case id stops meaning anything', () => {
    const { grants } = store();
    const first = grants.hold({ name: 'K', agent: 'pi:s1', value: 'old', until: T0 + 60 * MIN });
    const second = grants.hold({ name: 'K', agent: 'pi:s1', value: 'new', until: T0 + 60 * MIN });
    assert.equal(grants.take('pi:s1', 'K'), 'new');
    assert.equal(grants.revoke(first.caseId), false, 'the handle of a replaced decision no longer exists');
    assert.equal(grants.revoke(second.caseId), true);
  });

  it('lists what one agent may use, and nothing for another', () => {
    const { grants } = store();
    grants.hold({ name: 'A', agent: 'pi:s1', value: '1', until: T0 + 60 * MIN });
    grants.hold({ name: 'B', agent: 'pi:s1', value: '2', until: T0 + 60 * MIN });
    grants.hold({ name: 'C', agent: 'pi:s2', value: '3', until: T0 + 60 * MIN });
    assert.deepEqual(grants.names('pi:s1').sort(), ['A', 'B']);
    assert.deepEqual(grants.names('pi:s2'), ['C']);
    assert.deepEqual(grants.names('claude:x'), []);
  });

  it('says the case id and both clocks, and never the value', () => {
    const { grants } = store();
    const grant = grants.hold({ name: 'K', agent: 'pi:s1', value: 'hunter2', until: T0 + 60 * MIN, idleMs: 5 * MIN });
    const said = grants.describe(grant);
    assert.ok(!said.includes('hunter2'), 'the text a card shows carries no value');
    assert.ok(said.includes(grant.caseId), 'the handle can be copied out of the card');
    assert.ok(said.includes('5 min'), 'the idle window is stated');
  });

  it('will not be talked past a day, whatever the card asked for', () => {
    const { grants } = store();
    const grant = grants.hold({ name: 'K', agent: 'pi:s1', value: 'v', until: T0 + 7 * 24 * 60 * MIN });
    assert.equal(grant.until, T0 + MAX_UNTIL_MS);
  });

  it('sweeps what is already dead, and leaves the living alone', () => {
    const { grants, at } = store();
    grants.hold({ name: 'A', agent: 'pi:s1', value: '1', until: T0 + 10 * MIN });
    // B outlives A on both clocks, so only one of them is dead when the sweep runs.
    grants.hold({ name: 'B', agent: 'pi:s1', value: '2', until: T0 + 60 * MIN, idleMs: 60 * MIN });
    at(T0 + 20 * MIN);
    assert.equal(grants.sweep(), 1);
    assert.equal(grants.live('pi:s1', 'B'), true);
    assert.equal(grants.live('pi:s1', 'A'), false);
  });
});
