// The page asks the inbox about the card links the state leaves out, once per id, however often it draws.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linkLookup } from '../../web/details.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the card link lookup', () => {
  it('asks once for every id, and keeps the answer', async () => {
    const asked: string[][] = [];
    const lookup = linkLookup(async (ids: string[]) => { asked.push(ids); return { a: { title: 'A' } }; }, () => {});
    lookup.want(['a', 'b']);
    lookup.want(['a', 'b']);
    await settle();
    lookup.want(['a', 'b']);
    assert.deepEqual(asked, [['a', 'b']]);
    assert.deepEqual(lookup.get('a'), { title: 'A' });
    assert.equal(lookup.get('b'), null);
  });

  it('does not ask again after a failed request, however often the page draws', async () => {
    let calls = 0;
    let lookup: ReturnType<typeof linkLookup>;
    // The page draws again when a request ends, and every draw asks for the same ids.
    lookup = linkLookup(async () => { calls++; throw new Error('the inbox answered 404'); }, () => lookup.want(['a']));
    lookup.want(['a']);
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(calls, 1);
    assert.equal(lookup.get('a'), null);
  });
});
