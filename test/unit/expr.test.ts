import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse, test } from '../../src/core/expr.ts';

const card = { kind: 'blocked', waitMinutes: 45, rating: 3, tags: { topic: 'release' }, labels: ['ci', 'docs'] };

describe('priority rules', () => {
  it('compares card properties', () => {
    assert.equal(test('kind == "blocked"', card), true);
    assert.equal(test('waitMinutes > 30 && rating >= 3', card), true);
    assert.equal(test('waitMinutes > 60 || tags.topic == \'release\'', card), true);
    assert.equal(test('!(kind == "ask")', card), true);
    assert.equal(test('"ci" in labels && "topic" in tags', card), true);
    assert.equal(test('waitMinutes / 15 - 1 == 2', card), true);
  });

  it('reads a missing property as undefined, never from the prototype', () => {
    assert.equal(test('missing == null', card), false);
    assert.equal(test('tags.constructor', card), false);
    assert.equal(test('tags.__proto__', card), false);
  });

  it('reports where an unexpected character is', () => {
    assert.throws(() => parse('kind == "x" @'), /at 13/);
  });

  it('refuses anything outside the grammar', () => {
    for (const bad of ['process.exit()', 'kind = "x"', 'a ? b : c', '`x`', 'kind ==', 'x'.repeat(501)]) {
      assert.throws(() => parse(bad), Error, bad.slice(0, 20));
    }
  });
});
