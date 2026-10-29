// The inbox reads a card body with the page's own parser and component list, and refuses a body the page would draw only in part.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bodyErrors } from '../../src/adapters/openui-body.ts';
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

  it('refuses a reference to a statement the body never defines, and a component it does not know', () => {
    assert.match(bodyErrors('root = Card([a, b])\na = TextContent("hi")').join('\n'), /`b` is used but never defined/);
    assert.match(bodyErrors('root = Card([a])\na = Banner("hi")').join('\n'), /Banner/);
  });

  it('refuses a body with no root statement, such as Markdown', () => {
    assert.match(bodyErrors('I posted a preview.\n\n**What to check:** the thread.').join('\n'), /no `root = \.\.\.` statement.*text/);
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
