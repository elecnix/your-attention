// What the sign-in page makes of the text a person types or pastes: a link, a long code, a short code or an owner token.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupCode, readSignIn } from '../../web/sign-in.js';

describe('the sign-in field', () => {
  it('reads the code out of a pasted sign-in link, whatever the address', () => {
    assert.deepEqual(readSignIn('https://inbox.example/i/abc/#signin=0123456789abcdef0123456789abcdef'), { code: '0123456789abcdef0123456789abcdef' });
    assert.deepEqual(readSignIn('  http://mac.local:4815/#signin=0123456789abcdef0123456789abcdef\n'), { code: '0123456789abcdef0123456789abcdef' });
  });

  it('reads an owner token out of a pasted link', () => {
    assert.deepEqual(readSignIn('https://inbox.example/i/abc/#token=t1.secret'), { token: 't1.secret' });
  });

  it('passes a typed code on as typed, and the inbox reads the case, spaces and dashes', () => {
    assert.deepEqual(readSignIn('abcd-efgh'), { code: 'abcd-efgh' });
    assert.deepEqual(readSignIn(' 0123456789abcdef0123456789abcdef '), { code: '0123456789abcdef0123456789abcdef' });
  });

  it('takes nothing from an empty field', () => {
    assert.equal(readSignIn('   '), null);
  });

  it('shows a short code in two groups of four', () => {
    assert.equal(groupCode('ABCDEFGH'), 'ABCD-EFGH');
  });
});
