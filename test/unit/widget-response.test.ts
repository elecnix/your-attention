// A widget can say when to use it, and carry a response: text the inbox fills from the person's answer and hands to the agent.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAnswer } from '../../src/client.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { respond } from '../../src/core/widgets.ts';

const agent: Caller = { token: 't', role: 'agent' };

const SOURCE = [
  'root = FormControl("Ask for a review", ask)',
  'ask = CheckWithText("Ask the team", check, [msg])',
  'check = CheckBoxGroup("ask_review", [yes])',
  'yes = CheckBoxItem("", "", "yes")',
  'msg = TextArea("message", "", 6, {}, {{message}})',
].join('\n');
const RESPONSE = '{{#ask_review}}Post this to the team channel:\n{{message}}\nfor {{url}}{{/ask_review}}{{^ask_review}}Do not post to the team channel.{{/ask_review}}';

describe('widget responses', () => {
  it('fills a response from the answer, falling back to the values the agent placed, with sections for a choice', () => {
    const placed = { message: '> Fixes the build.\nhttps://example.com/pull/1', url: 'https://example.com/pull/1' };
    assert.equal(respond(RESPONSE, { ask_review: { yes: true } }, placed), 'Post this to the team channel:\n> Fixes the build.\nhttps://example.com/pull/1\nfor https://example.com/pull/1');
    assert.equal(respond(RESPONSE, { ask_review: { yes: true }, message: 'Edited.' }, placed), 'Post this to the team channel:\nEdited.\nfor https://example.com/pull/1');
    assert.equal(respond(RESPONSE, { ask_review: { yes: false } }, placed), 'Do not post to the team channel.');
    assert.equal(respond(RESPONSE, {}, placed), 'Do not post to the team channel.');
  });

  it('saves a widget with when to use it and its response, and lists the catalog in the card guidance', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1000);
    inbox.saveWidget('team-review', SOURCE, undefined, { when: 'A pull request needs a review from the team.', response: RESPONSE });
    const w = inbox.getWidget('team-review');
    assert.equal(w.versions.at(-1)?.when, 'A pull request needs a review from the team.');
    assert.equal(w.versions.at(-1)?.response, RESPONSE);
    const catalog = inbox.widgetCatalog();
    assert.match(catalog, /team-review: A pull request needs a review from the team\./);
    assert.match(catalog, /values: message/);
    // A when that is not text is kept as text, never a crash.
    assert.equal(inbox.saveWidget('odd', SOURCE, undefined, { when: 5 as unknown as string }).versions.at(-1)?.when, '5');
  });

  it('hands the agent the filled response with the answer', async () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1000);
    inbox.saveWidget('team-review', SOURCE, undefined, { when: 'A pull request needs a review.', response: RESPONSE });
    const card = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Merge it?', body: `root = Card([r])\nr = widget team-review ${JSON.stringify({ message: 'Quoted TLDR', url: 'https://example.com/pull/2' })}` });
    const answer = await inbox.answer('c1', { values: { ask_review: { yes: true } } });
    assert.deepEqual(answer.responses, ['Post this to the team channel:\nQuoted TLDR\nfor https://example.com/pull/2']);
    assert.match(describeAnswer(card, answer), /Post this to the team channel:\nQuoted TLDR/);
  });
});
