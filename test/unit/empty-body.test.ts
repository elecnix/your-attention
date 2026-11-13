// An empty body is no body. An agent that passes `body: ""` to card_post, or a client that turns a missing body into an
// empty string, must get a card, not a message telling it to rewrite a body that does not exist.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { bodyErrors } from '../../src/adapters/openui-body.ts';

function setup() {
  return { inbox: new Inbox(new MemoryStorage(), () => 1_000_000), agent: { token: 'ta', role: 'agent' } satisfies Caller };
}

describe('an empty card body', () => {
  it('posts a card with body "" as a card with no body', () => {
    const { inbox, agent } = setup();
    const card = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Plan', text: 'Prose.', body: '' });
    assert.equal(card.body, undefined);
    assert.equal(card.text, 'Prose.');
  });

  it('posts a card whose body is only whitespace as a card with no body', () => {
    const { inbox, agent } = setup();
    assert.equal(inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Plan', body: '  \n ' }).body, undefined);
  });

  it('reads no faults from an empty body, which an inbox may already hold', () => {
    assert.deepEqual(bodyErrors(''), []);
    assert.deepEqual(bodyErrors('  \n'), []);
  });

  it('still refuses a body that has content and no root statement, and says what to add', () => {
    const { inbox, agent } = setup();
    assert.throws(
      () => inbox.postCard(agent, { id: 'c3', agent: 's1', title: 'Plan', body: 'TextContent("hi")' }),
      (e: unknown) => e instanceof Error && /no `root = \.\.\.` statement/.test(e.message) && /root = /.test(e.message),
    );
  });
});
