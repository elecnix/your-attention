// A link in card text that points at this inbox's own card address opens that card in place, not in a new tab.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ownCardId } from '../../web/answers.js';

const here = 'http://127.0.0.1:4815/';

describe('a link to this inbox', () => {
  it('names the card of a same-origin #card address', () => {
    assert.equal(ownCardId('http://127.0.0.1:4815/#card=fc6b7f3a', here), 'fc6b7f3a');
    assert.equal(ownCardId('/#card=fc6b7f3a', here), 'fc6b7f3a');
    assert.equal(ownCardId('#card=fc6b7f3a', here), 'fc6b7f3a');
    assert.equal(ownCardId('http://127.0.0.1:4815/inbox#card=fc6b7f3a', 'http://127.0.0.1:4815/inbox'), 'fc6b7f3a');
  });

  it('leaves another inbox and another kind of link alone', () => {
    assert.equal(ownCardId('https://someone.cloud/#card=fc6b7f3a', here), undefined);
    assert.equal(ownCardId('http://127.0.0.1:4815/#signin=abc', here), undefined);
    assert.equal(ownCardId('http://127.0.0.1:4815/v1/state', here), undefined);
    assert.equal(ownCardId('https://example.com/#card=fc6b7f3a', here), undefined);
    assert.equal(ownCardId('not a url', here), undefined);
  });
});
