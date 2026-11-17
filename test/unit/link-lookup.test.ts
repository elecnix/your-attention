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

  it('reads only the ids the inbox answered, never a name inherited from Object', async () => {
    const lookup = linkLookup(async () => ({}), () => {});
    lookup.want(['toString', 'constructor']);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(lookup.get('toString'), null);
    assert.equal(lookup.get('constructor'), null);
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

  it('asks about more than 20 links in batches of 20, as the page draws again after each answer', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
    const asked: string[][] = [];
    let lookup: ReturnType<typeof linkLookup>;
    lookup = linkLookup(async (batch: string[]) => { asked.push(batch); return Object.fromEntries(batch.map((id) => [id, { title: id }])); }, () => lookup.want(ids));
    lookup.want(ids);
    for (let i = 0; i < 5; i++) await settle();
    assert.deepEqual(asked.map((b) => b.length), [20, 5]);
    assert.deepEqual(asked.flat(), ids);
    assert.deepEqual(lookup.get('c24'), { title: 'c24' });
  });
});
