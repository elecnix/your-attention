// The inbox reads a card body with the page's own parser and component list, and refuses a body the page would draw only in part.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bodyErrors, fallbackBody } from '../../src/adapters/openui-body.ts';
import { Inbox, InboxError, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';

const agent: Caller = { token: 't', role: 'agent' };
const GOOD = [
  'root = Card([intro, f1])',
  'intro = TextContent("Two fixes are ready.")',
  'none = Buttons([])',
  'f1 = Form("f1", none, [TextContent("**1. Rename the column.**"), FormControl("Tweak 1", CheckBoxGroup("t1", [CheckBoxItem("Rename it", "", "rename")])), FormControl("Comment", Input("c1", "Optional"))])',
].join('\n');

describe('card body check', () => {
  it('passes a body the page draws whole, with the components the page adds', () => {
    assert.deepEqual(bodyErrors(GOOD), []);
    assert.deepEqual(bodyErrors('root = Card([d])\nd = Mermaid("graph TD; A-->B")'), []);
    assert.deepEqual(bodyErrors('root = Card([r])\nr = FormControl("Ask", ask)\nask = CheckWithText("Ask the team", check, [msg])\ncheck = CheckBoxGroup("ask", [yes])\nyes = CheckBoxItem("", "", "yes")\nmsg = TextArea("message", "", 6)'), []);
  });

  it('names the statement whose string never closes, and the statements it swallowed', () => {
    // An agent escaped every quote from the fourth statement on, so its first string runs to the end of the body.
    const lines = [...GOOD.replace('root = Card([intro, f1])', 'root = Card([intro, f1, f2])').split('\n'), 'f2 = TextContent("more")'];
    const errors = bodyErrors(lines.map((l, i) => (i >= 3 ? l.replaceAll('"', '\\"') : l)).join('\n'));
    assert.ok(errors.some((e) => /`f1` \(line 4\)/.test(e) && /\\"/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /`f2`/.test(e) && /never defined/.test(e)), errors.join('\n'));
  });

  it('counts a line inside a string as part of its statement, so it names the statement whose string never closes', () => {
    const body = 'root = Card([a, b, c])\na = TextContent("Two lines:\nx = y")\nb = TextContent(\\"open)\nc = TextContent("c")';
    assert.match(bodyErrors(body).join('\n'), /`b` \(line 4\) has a string that never closes/);
  });

  it('refuses a reference to a statement the body never defines, and a component it does not know', () => {
    assert.match(bodyErrors('root = Card([a, b])\na = TextContent("hi")').join('\n'), /`b` is used but never defined/);
    assert.match(bodyErrors('root = Card([a])\na = Banner("hi")').join('\n'), /Banner/);
  });

  it('refuses a body with no root statement, such as Markdown', () => {
    assert.match(bodyErrors('I posted a preview.\n\n**What to check:** the thread.').join('\n'), /no `root = \.\.\.` statement.*text/);
    // A root after an unclosed string is still there: the error names the string.
    assert.match(bodyErrors('a = TextContent("oops)\nroot = Card([a])').join('\n'), /`a` \(line 1\) has a string that never closes/);
  });

  it('refuses such a card at post and at patch, and the error says how to fix it', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1000, undefined, { checkBody: bodyErrors });
    assert.throws(() => inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Broken?', body: 'root = Card([a, b])\na = TextContent("hi")' }),
      (e: unknown) => e instanceof InboxError && e.status === 400 && /body/.test(e.message) && /`b`/.test(e.message));
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Fine?', body: GOOD });
    assert.throws(() => inbox.patchCard(agent, 'c2', [{ old: 'Form("f1", none, [TextContent("', new: 'Form(\\"f1\\", none, [TextContent(\\"' }]), (e: unknown) => e instanceof InboxError && e.status === 400);
    assert.equal(inbox.getCard('c2').body, GOOD);
  });
});

describe('fallback for a stored broken body', () => {
  // As an agent wrote it: the quotes escaped from the fourth statement on.
  const broken = [
    'root = Card([sum, tl, f1, h2])',
    'none = Buttons([])',
    'sum = TextContent("**Summary.** Staging is green again.")',
    'tl = TextContent("| Time | What |\\n|---|---|\\n| 14:41 | merged |")',
    'f1 = Form(\\"a1\\", none, [FormControl(\\"Fix 1\\", Input(\\"c1\\", \\"Optional\\"))])',
    'h2 = TextContent(\\"**2. The IAM check.**\\")',
  ].join('\n');

  it('draws every statement before the broken one, and shows the source from it on', () => {
    const f = fallbackBody(broken);
    assert.ok(f);
    assert.deepEqual(bodyErrors(f.body), []);
    assert.match(f.body, /^sum = TextContent\("\*\*Summary/m);
    assert.match(f.body, /^tl = /m);
    assert.match(f.body, /yaSource = CodeBlock\("text", "f1 = Form/);
    assert.doesNotMatch(f.body, /yaSource = CodeBlock\("text", "root/);
    assert.match(f.faults.join('\n'), /`f1` \(line 5\)/);
  });

  it('shows the whole source when the root statement itself is broken, and nothing for a body that draws whole', () => {
    const f = fallbackBody('root = Card([a])\na = TextContent(\\"x\\")'.replace('root = Card([a])', 'root = Card([a, \\"b])'));
    assert.ok(f);
    assert.deepEqual(bodyErrors(f.body), []);
    assert.match(f.body, /yaSource = CodeBlock\("text", "root = Card/);
    assert.equal(fallbackBody('root = Card([a])\na = TextContent("x")'), undefined);
  });

  it('hands the page the fallback with each stored card whose body does not draw whole', () => {
    const inbox = new Inbox(new MemoryStorage(), () => 1000, undefined, { checkBody: bodyErrors, fallbackBody });
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Old?', body: GOOD });
    inbox['store'].put('cards', 'old', { ...inbox.getCard('old'), body: broken });
    inbox.postCard(agent, { id: 'fine', agent: 's1', title: 'Fine?', body: GOOD });
    const cards = inbox.state().cards;
    assert.match(cards.find((c) => c.id === 'old')?.bodyFallback?.body ?? '', /yaSource/);
    assert.equal(cards.find((c) => c.id === 'fine')?.bodyFallback, undefined);
    // The stored card keeps the body the agent sent.
    assert.equal(inbox.getCard('old').body, broken);
  });
});
