// Text in the terminal: how wide it is, what an agent may not send to the screen, and how a line wraps.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clip, graphemes, sanitize, textWidth, wrap } from '../../src/tui/text.ts';

describe('terminal text', () => {
  it('counts wide characters, emoji and combining marks as the terminal draws them', () => {
    assert.equal(textWidth('abc'), 3);
    assert.equal(textWidth('日本'), 4);
    assert.equal(textWidth('✋'), 2);
    assert.equal(textWidth('é'), 1);
    assert.equal(textWidth('👍🏽'), 2);
    assert.equal(textWidth('→'), 1);
    assert.deepEqual(graphemes('aéb'), ['a', 'é', 'b']);
  });

  it('strips escape sequences and other control characters an agent could use to take over the terminal', () => {
    assert.equal(sanitize('ok\x1b[2Jgone\x07'), 'ok[2Jgone');
    assert.equal(sanitize('a‮b⁦c'), 'abc');
    assert.equal(sanitize('tab\there'), 'tab  here');
    assert.equal(sanitize('\x9b31m'), '31m');
  });

  it('wraps at spaces, breaks a word longer than the line, and keeps each line inside the width', () => {
    assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
    assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
    assert.deepEqual(wrap('日本語の文', 4), ['日本', '語の', '文']);
    assert.deepEqual(wrap('', 5), ['']);
    for (const line of wrap('a long line of words that wraps several times over', 7)) assert.ok(textWidth(line) <= 7);
  });

  it('clips to a width with an ellipsis, never cutting a wide character in half', () => {
    assert.equal(clip('hello world', 8), 'hello w…');
    assert.equal(clip('hello', 8), 'hello');
    assert.equal(clip('日本語', 5), '日本…');
    assert.equal(clip('hello world', 8, '...'), 'hello...');
  });
});
