// An empty body is no body. An agent that passes `body: ""` to card_post, or a client that turns a missing body into an
// empty string, must get a card, not a message telling it to rewrite a body that does not exist.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { bodyErrors } from '../../src/adapters/openui-body.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { httpInbox } from './fixture.ts';

function setup() {
  // The laptop inbox refuses a body the page cannot draw; the unit store has to be told to, as server.ts does.
  return {
    inbox: new Inbox(new MemoryStorage(), () => 1_000_000, undefined, { checkBody: bodyErrors }),
    agent: { token: 'ta', role: 'agent' } satisfies Caller,
  };
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
    assert.equal(inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Plan', text: 'Prose.', body: '  \n ' }).body, undefined);
  });

  it('reads no faults from an empty body, which an inbox may already hold', () => {
    assert.deepEqual(bodyErrors(''), []);
    assert.deepEqual(bodyErrors('  \n'), []);
  });

  it('still refuses a body that has content and no root statement, and says what to add', () => {
    const { inbox, agent } = setup();
    assert.throws(
      () => inbox.postCard(agent, { id: 'c3', agent: 's1', title: 'Plan', body: 'TextContent("hi")' }),
      (e: unknown) => e instanceof Error
        && /no `root = \.\.\.` statement, and a body needs one/.test(e.message)
        && /root = TextContent/.test(e.message)
        && /leave body out/.test(e.message),
    );
  });
});



// A card with only a title gives the person nothing to read: no question, no options, no body. Both paths an agent posts
// through refuse it, so a client that loses the card's content learns it then, not from an empty card in the inbox.
describe('a card with nothing to read', () => {
  const refusal = /needs something the person can read/;

  it('is refused by card_post, before the inbox stores it', async () => {
    let posted = 0;
    const inbox = { post: async () => { posted += 1; return { id: 'c1' }; } } as never;
    await assert.rejects(
      runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', { title: 'Merge layer 3' }),
      refusal,
    );
    assert.equal(posted, 0);
  });

  it('is refused by card_post, the route every MCP and extension tool lands on', async () => {
    const inbox = { post: async () => ({ id: 'c1' }) } as never;
    await assert.rejects(
      runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', { title: 'Merge layer 3', vars: {} }),
      /vars fills a template/,
    );
  });

  it('refuses a body that normalizes to nothing, as the inbox stores no body for it', async () => {
    for (const body of ['', '   ', '\n']) {
      const inbox = { post: async () => ({ id: 'c1' }) } as never;
      await assert.rejects(
        runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', { title: 'Merge layer 3', body }),
        refusal,
      );
    }
  });

  it('refuses a question or an option that reads blank', async () => {
    for (const args of [{ questions: [{}] }, { questions: [{ question: '   ' }] }, { options: [{ label: '' }] }, { options: [{ label: '  ' }] }]) {
      const inbox = { post: async () => ({ id: 'c1' }) } as never;
      await assert.rejects(
        runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', { title: 'Merge layer 3', ...args }),
        refusal,
      );
    }
  });

  it('refuses questions or options that are not a list, without throwing a type error', async () => {
    for (const args of [{ questions: {} }, { options: 'x' }]) {
      const inbox = { post: async () => ({ id: 'c1' }) } as never;
      await assert.rejects(
        runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', { title: 'Merge layer 3', ...args }),
        refusal,
      );
    }
  });

  it('posts a card that reads, even when it also passes vars without a template', async () => {
    const inbox = { post: async () => ({ id: 'c1' }) } as never;
    await runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', { title: 'Merge layer 3', text: 'Ship it?', vars: {} });
  });

  it('still posts a card that carries any one thing to read', async () => {
    const bodies = [
      { title: 'Text', text: 'Ship it?' },
      { title: 'Options', options: [{ label: 'Ship it' }] },
      { title: 'Questions', questions: [{ question: 'Ship it?' }] },
      { title: 'Html', html: '<p>Ship it?</p>' },
      { title: 'File', attachments: [{ url: 'https://example.com/a.png' }] },
      { title: 'Rec', text: 'Ship it?', recommendation: 'Yes.' },
    ];
    for (const body of bodies) {
      const inbox = { post: async () => ({ id: 'c1' }) } as never;
      await runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_post', body);
    }
  });

  it('lets the inbox post a card of its own with only a title, since it carries its ask elsewhere', () => {
    const { inbox } = setup();
    const card = inbox.postCard({ token: '', role: 'owner' }, { id: 'sys', agent: 'system', kind: 'system', title: 'Send new card guidance to agents?' });
    assert.equal(card.id, 'sys');
  });
});
