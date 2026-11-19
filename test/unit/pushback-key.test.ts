import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pushbackKey } from '../../web/answers.js';

describe('the key of a triage pushback row on the page', () => {
  it('differs for two extensions that pass one card with advice at the same moment', () => {
    const a = { kind: 'advice', by: 'triage-example', reason: 'Say which branch.', version: 1, at: 5 };
    const b = { kind: 'advice', by: 'house-style', reason: 'Drop the hedge.', version: 1, at: 5 };
    assert.notEqual(pushbackKey(a), pushbackKey(b));
  });

  it('differs for a return and advice on one version', () => {
    assert.notEqual(pushbackKey({ kind: 'returned', by: 'triage', version: 2, at: 9 }), pushbackKey({ kind: 'advice', by: 'triage', version: 2, at: 9 }));
  });
});
