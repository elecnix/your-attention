// The recommended option: the inbox's rule on how many an option list may mark, and the matcher the page and the
// terminal client share to find the option a recommendation names.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { createHandler } from '../../src/core/http.ts';
import { recommendationNames, recommendedOptions } from '../../web/answers.js';

const agent: Caller = { token: 'ta', role: 'agent' };
const opts = (...labels: string[]) => labels.map((label, i) => ({ id: `o${i + 1}`, label }));

describe('a recommended option on a card', () => {
  it('stores the flag on the option', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    const card = inbox.postCard(agent, { id: 'r1', agent: 's1', title: 'Ship?', options: [{ id: 'y', label: 'Ship', recommended: true }, { id: 'n', label: 'Wait' }] });
    assert.equal(card.options?.[0]?.recommended, true);
  });

  it('refuses a single-choice card with two recommended options, and takes several on a multiple-choice card', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1);
    const two = [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }];
    assert.throws(() => inbox.postCard(agent, { id: 'r2', agent: 's1', title: 'Pick one', options: two }),
      (e: unknown) => e instanceof InboxError && e.status === 400 && /recommended/.test(e.message));
    assert.equal(inbox.postCard(agent, { id: 'r3', agent: 's1', title: 'Pick some', multiple: true, options: two }).options?.filter((o) => o.recommended).length, 2);
  });

  it('answers 400 over HTTP for two recommended options on a single-choice card', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const token = (await inbox.createToken('agents', 'agent')).secret;
    const handler = createHandler(inbox, { heartbeatMs: 50 });
    const res = await handler(new Request('http://inbox/v1/cards', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'r4', agent: 's1', title: 'Pick one', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }] }),
    }));
    assert.equal(res.status, 400);
  });
});

describe('recommendationNames', () => {
  it('matches a recommendation that starts with the label and a sentence end, a comma, a colon or the end', () => {
    for (const rec of ['Go ahead. A read-only key exposes nothing.', 'go ahead, since the key is read-only', 'Go ahead: the key is read-only.', 'Go ahead', 'Go ahead!', 'Go ahead? Yes.', '**Go ahead.** The key is read-only.', '*Go ahead*: read-only.', '  Go ahead.'])
      assert.equal(recommendationNames(rec, 'Go ahead'), true, rec);
  });

  it('does not match a shorter label, a longer word, or a label later in the text', () => {
    for (const [rec, label] of ([['Go ahead. A read-only key.', 'Go'], ['Going ahead.', 'Go'], ['Go aheadly.', 'Go ahead'], ['I would go ahead.', 'Go ahead'], ['Go ahead and merge.', 'Go ahead'], ['', 'Go ahead'], ['Go ahead.', '']] as [string, string][]))
      assert.equal(recommendationNames(rec, label), false, `${rec} / ${label}`);
  });

  it('ignores emphasis in the label too, and takes a label that ends a sentence itself', () => {
    assert.equal(recommendationNames('Merge it. Tests pass.', '**Merge it**'), true);
    assert.equal(recommendationNames('Yes. Tests pass.', 'Yes.'), true);
  });
});

describe('recommendedOptions', () => {
  it('takes the marked options first, and puts the recommendation inside the one marked option', () => {
    const card = { recommendation: 'Wait. CI is red.', options: [{ id: 'y', label: 'Ship', recommended: true }, { id: 'n', label: 'Wait' }] };
    assert.deepEqual(recommendedOptions(card), { ids: ['y'], inside: true });
  });

  it('infers the option the recommendation starts with, and picks the longest label that matches', () => {
    assert.deepEqual(recommendedOptions({ recommendation: 'Go ahead. A read-only key exposes nothing.', options: [{ id: 'a', label: 'Go ahead' }, { id: 'b', label: 'No Datadog key in PR CI' }] }), { ids: ['a'], inside: true });
    assert.deepEqual(recommendedOptions({ recommendation: 'Yes, but later.', options: opts('Yes', 'Yes, but later', 'No') }), { ids: ['o2'], inside: true });
  });

  it('finds none when nothing matches, so the recommendation keeps its own box', () => {
    assert.deepEqual(recommendedOptions({ recommendation: 'SQLite, since it is one file.', options: opts('Use SQLite', 'Use Postgres') }), { ids: [], inside: false });
    assert.deepEqual(recommendedOptions({ recommendation: 'Go.', options: [] }), { ids: [], inside: false });
  });

  it('tags several marked options on a multiple-choice card, and keeps the recommendation in its box', () => {
    const card = { multiple: true, recommendation: 'Both.', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }] };
    assert.deepEqual(recommendedOptions(card), { ids: ['a', 'b'], inside: false });
  });

  it('marks nothing on a card whose options the page does not draw: an HTML card, or a body with its own form', () => {
    const options = [{ id: 'a', label: 'Go ahead', recommended: true }];
    assert.deepEqual(recommendedOptions({ html: '<p>x</p>', recommendation: 'Go ahead.', options }), { ids: [], inside: false });
    assert.deepEqual(recommendedOptions({ body: 'root = Card([f])\nf = Form("f", b, [])', recommendation: 'Go ahead.', options }), { ids: [], inside: false });
  });
});
