import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStorage } from '../../src/core/storage.ts';
import { Inbox, InboxError } from '../../src/core/inbox.ts';
import { expandWidgets } from '../../src/core/widgets.ts';

const PR = [
  'root = Card([head, state], "sunk")',
  'head = CardHeader({{title}}, {{repo}})',
  'state = Tag({{ci}}, null, "sm", "success")',
].join('\n');

const find = (sources: Record<string, string>) => (name: string, version?: number) => {
  if (!(name in sources)) throw new InboxError(404, `unknown widget ${name}`);
  return { name, version: version ?? 1, source: sources[name]! };
};

describe('widgets', () => {
  it('replace a placing line with the widget, its names prefixed and its root bound to the placed name', () => {
    const body = 'root = Card([intro, pr])\nintro = TextContent("Review this.")\npr = widget pull-request {"title": "Add stop", "repo": "your-attention", "ci": "green"}';
    const { body: out, used } = expandWidgets(body, find({ 'pull-request': PR }));
    assert.equal(out, [
      'root = Card([intro, pr])',
      'intro = TextContent("Review this.")',
      'pr = Card([pr_head, pr_state], "sunk")',
      'pr_head = CardHeader("Add stop", "your-attention")',
      'pr_state = Tag("green", null, "sm", "success")',
    ].join('\n'));
    assert.deepEqual(used, [{ name: 'pull-request', version: 1 }]);
  });

  it('place one widget twice without the two clashing, and leave names inside strings alone', () => {
    const body = 'root = Card([a, b])\na = widget pull-request {"title": "head and state", "repo": "r", "ci": "red"}\nb = widget pull-request {"title": "Two", "repo": "r", "ci": "green"}';
    const out = expandWidgets(body, find({ 'pull-request': PR })).body;
    assert.match(out, /^a_head = CardHeader\("head and state", "r"\)$/m);
    assert.match(out, /^b_head = CardHeader\("Two", "r"\)$/m);
    assert.match(out, /^b = Card\(\[b_head, b_state\], "sunk"\)$/m);
  });

  it('place widgets inside widgets, and refuse a widget that places itself', () => {
    const sources = { list: 'root = Card([one])\none = widget pull-request {"title": "Inner", "repo": "r", "ci": "green"}', 'pull-request': PR, loop: 'root = Card([me])\nme = widget loop {}' };
    assert.match(expandWidgets('root = Card([l])\nl = widget list {}', find(sources)).body, /^l_one_head = CardHeader\("Inner", "r"\)$/m);
    assert.throws(() => expandWidgets('root = Card([x])\nx = widget loop {}', find(sources)), /widget loop places itself/);
  });

  it('refuse values that are not a JSON object, and widgets nobody saved', () => {
    assert.throws(() => expandWidgets('x = widget pull-request {title}', find({ 'pull-request': PR })), (e: InboxError) => e.status === 400 && /JSON object/.test(e.message));
    assert.throws(() => expandWidgets('x = widget nope {}', find({})), (e: InboxError) => e.status === 404);
  });

  it('are saved with versions, filled into card bodies and templates, and recorded on the card', () => {
    const inbox = new Inbox(new MemoryStorage());
    const agent = { token: 'ta', role: 'agent' as const };
    assert.throws(() => inbox.saveWidget('pull-request', 'head = CardHeader("x")'), /must define root/);
    inbox.saveWidget('pull-request', PR);
    inbox.saveWidget('pull-request', PR.replace('"success"', '"info"'), 'Blue while CI runs.');
    assert.equal(inbox.getWidget('pull-request').versions.length, 2);
    const card = inbox.postCard(agent, { agent: 's1', title: 'Merge?', body: 'root = Card([pr])\npr = widget pull-request@1 {"title": "Add stop", "repo": "r", "ci": "green"}' });
    assert.match(card.body ?? '', /pr_state = Tag\("green", null, "sm", "success"\)/);
    assert.deepEqual(card.widgets, [{ name: 'pull-request', version: 1 }]);
    inbox.saveTemplate('merge', 'root = Card([q, pr])\nq = TextContent({{question}})\npr = widget pull-request {"title": "T", "repo": "r", "ci": "running"}');
    const fromTemplate = inbox.postCard(agent, { agent: 's1', title: 'Merge?', template: { name: 'merge', vars: { question: 'Merge it?' } } });
    assert.match(fromTemplate.body ?? '', /pr_state = Tag\("running", null, "sm", "info"\)/);
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'x', body: 'root = Card([p])\np = widget missing {}' }), (e: InboxError) => e.status === 404);
  });
});

describe('a patched card with widgets', () => {
  it('keeps the record of the widgets its body placed', () => {
    const inbox = new Inbox(new MemoryStorage());
    const agent = { token: 'ta', role: 'agent' as const };
    inbox.saveWidget('pull-request', PR);
    inbox.postCard(agent, { id: 'p1', agent: 's1', title: 'Merge?', body: 'root = Card([pr])\npr = widget pull-request {"title": "T", "repo": "r", "ci": "running"}' });
    const patched = inbox.patchCard(agent, 'p1', [{ old: 'Tag("running"', new: 'Tag("green"' }], 'body');
    assert.match(patched.body ?? '', /pr_state = Tag\("green"/);
    assert.deepEqual(inbox.getCard('p1').widgets, [{ name: 'pull-request', version: 1 }]);
  });
});
