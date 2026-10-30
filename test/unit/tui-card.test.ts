// The card pane: each widget draws, Tab walks the fields in order, and the answer has the values the page sends for
// the same card and the same clicks. The expected values come from the page's own browser tests.
import { summarize } from '../../src/core/summary.ts';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { describe as describeAnswer } from '../../web/answers.js';
import { buildQueue, type InboxState } from '../../web/queue.js';
import { editKey } from '../../src/tui/edit.ts';
import type { Card } from '../../src/core/types.ts';
import { loadParser } from '../../src/tui/body.ts';
import { CardView, type CardViewHost } from '../../src/tui/cardview.ts';
import type { KeyEvent } from '../../src/tui/input.ts';
import { makeTheme } from '../../src/tui/theme.ts';

const theme = makeTheme({ color: 0, unicode: true, hyperlinks: false });

function card(c: Partial<Card> & { id: string; title: string }): Card {
  return { agent: 'a1', kind: 'ask', priority: 'now', deliver: 'stream', version: 1, createdAt: 0, updatedAt: 0, replies: [], ...c };
}

function setup(c: Card) {
  const acts: unknown[] = [];
  const host: CardViewHost = { theme, address: (id) => `http://127.0.0.1:4815/#card=${id}`, act: (_v, a) => acts.push(a), fileText: () => undefined, now: () => 600_000 };
  const s: InboxState = { cards: [summarize(c, undefined)], answers: {}, presence: {}, states: { [c.id]: 'open' }, levels: [{ id: 'now', label: 'Decide now', definition: '', color: '#e5484d' }] };
  const view = new CardView(c, host);
  const build = () => view.build(70, s, buildQueue(s, 'none'));
  build();
  const text = () => build().lines.map((l) => l.spans.map((x) => x.text).join('')).join('\n');
  /** Focus the stop whose id starts with `prefix`. */
  const focus = (prefix: string) => { build(); const id = view.stops().find((x) => x.startsWith(prefix)); assert.ok(id, `no stop ${prefix} in ${view.stops().join(', ')}`); view.focus = id; build(); };
  const key = (name: string, mods: Partial<KeyEvent> = {}) => { const ok = view.key({ type: 'key', name, ctrl: false, alt: false, shift: false, ...mods }); build(); return ok; };
  const type = (s: string) => { for (const ch of s) key(ch, { text: ch }); };
  return { view, acts, build, text, focus, key, type };
}

before(async () => { await loadParser(); });

const FORMS = `root = Card([intro, tbl, pr12, mid, pr13])
intro = TextContent("Two pull requests wait. Decide each one where it is described.")
tbl = Table([Col("PR", ["#12", "#13"]), Col("Risk", ["low", "high"])])
pr12 = Form("pr12", none, [c1, c2])
none = Buttons([])
c1 = FormControl("Merge #12?", r1)
r1 = RadioGroup("merge12", [RadioItem("Merge it", "", "yes"), RadioItem("Wait", "", "no")])
c2 = FormControl("Checks for #12", k1)
k1 = CheckBoxGroup("checks12", [CheckBoxItem("Rerun CI", "", "ci"), CheckBoxItem("Ask a reviewer", "", "review")])
mid = TextContent("#13 changes the deploy script.")
pr13 = Form("pr13", none, [c3, flags, note])
c3 = FormControl("Merge #13?", s1)
s1 = Select("merge13", [SelectItem("yes", "Merge it"), SelectItem("no", "Wait")])
flags = SwitchGroup("flags13", [SwitchItem("Deploy after merge", "", "deploy")])
note = Input("ticket", "Ticket")`;

describe('the card pane', () => {
  it('draws a closed card as closed while the state has no summary of it yet', () => {
    const c = card({ id: 'gone', title: 'Closed meanwhile', closed: { kind: 'resolved', outcome: 'Fixed upstream.', at: 1 } });
    const view = new CardView(c, { theme, address: () => '', act: () => {}, fileText: () => undefined, now: () => 600_000 });
    const s: InboxState = { cards: [], answers: {}, presence: {}, states: {} };
    const text = view.build(70, s, buildQueue(s, 'none')).lines.map((l) => l.spans.map((x) => x.text).join('')).join('\n');
    assert.match(text, /No longer waiting\] Fixed upstream\./);
  });

  it('draws a body with its text, table and fields in place, and sends what the page sends for the same picks', () => {
    const t = setup(card({ id: 'forms', title: 'Two pull requests', body: FORMS }));
    const screen = t.text();
    for (const words of ['Two pull requests wait.', 'PR', '#12', 'Merge #12?', '( ) Merge it', '[ ] Rerun CI', '[off] Deploy after merge', 'Ticket', '[ Send answer ]', '[ Skip for now ]']) assert.ok(screen.includes(words), `missing ${words}\n${screen}`);
    assert.ok(screen.indexOf('Merge #12?') < screen.indexOf('#13 changes the deploy script.'), 'the forms keep their places between the text');
    t.focus('field:pr12/merge12'); t.key('space');
    t.focus('field:pr12/checks12'); t.key('space');
    t.focus('field:pr13/flags13'); t.key('enter');
    t.focus('field:pr13/ticket'); t.type('T-7');
    t.focus('field:yaAnswer/comment'); t.type('Merge #12 first.');
    assert.deepEqual(t.view.answer(), { values: { merge12: 'yes', checks12: { ci: true, review: false }, flags13: { deploy: true }, ticket: 'T-7' }, comment: 'Merge #12 first.' });
    assert.ok(t.text().includes('(•) Merge it'));
  });

  it('joins a body comment field and the page comment box, the body first', () => {
    const t = setup(card({ id: 'own', title: 'Own comment field', body: 'root = Card([f])\nf = Form("f", b, [fc])\nfc = FormControl("Why?", TextArea("comment", "Say why", 2))\nb = Buttons([])' }));
    t.focus('field:f/comment'); t.type('Because of the outage.');
    t.focus('field:yaAnswer/comment'); t.type('Ship it after lunch.');
    assert.equal(t.view.answer().comment, 'Because of the outage.\nShip it after lunch.');
  });

  it('answers an options card with the option id, and questions by their labels', () => {
    const t = setup(card({ id: 'o', title: 'Pick', options: [{ id: 'o1', label: 'SQLite', description: 'One file' }, { id: 'o2', label: 'Postgres' }], questions: [{ question: 'Which test runner?', options: [{ label: 'node:test' }, { label: 'vitest' }] }] }));
    assert.ok(t.text().includes('One file'));
    t.focus('field:o/q0'); t.key('down'); t.key('enter');
    t.focus('field:o/choice'); t.key('2');
    assert.deepEqual(t.view.answer().values, { q0: 'vitest', choice: 'o2' });
    // A click on an option picks it too.
    const target = t.view.stops().find((x) => x === 'field:o/choice')!;
    t.view.click(`${target}#0`, 0, 0);
    assert.deepEqual(t.view.answer().values['choice'], 'o1');
  });

  it('keeps OptionCards defaults and toggles multiple picks, as OpenUI stores them', () => {
    const t = setup(card({ id: 'oc', title: 'Cards', body: 'root = Card([f])\nf = Form("f", b, [fc])\nb = Buttons([])\nfc = FormControl("Pick", OptionCards("pick", "multiple", [OptionCard("a", "A", "first"), OptionCard("b", "B")], {}, ["a"]))' }));
    assert.deepEqual(t.view.answer().values, { pick: ['a'] });
    t.focus('field:f/pick'); t.key('down'); t.key('space');
    assert.deepEqual(t.view.answer().values, { pick: ['a', 'b'] });
  });

  it('walks the Tab stops in the order the card draws them, and stops at each end', () => {
    const t = setup(card({ id: 'forms', title: 'Two pull requests', body: FORMS }));
    const stops = t.view.stops();
    assert.deepEqual(stops.slice(0, 5), ['field:pr12/merge12', 'field:pr12/checks12', 'field:pr13/merge13', 'field:pr13/flags13', 'field:pr13/ticket']);
    assert.equal(stops.at(-2), 'button:Send answer');
    t.view.focus = undefined;
    assert.equal(t.view.move(1), true);
    assert.equal(t.view.focus, 'field:pr12/merge12');
    t.view.focus = stops.at(-1);
    assert.equal(t.view.move(1), false);
  });

  it('sends a button press to the client, and a primary button checks its form rules first', () => {
    const t = setup(card({ id: 'r', title: 'Rules', body: 'root = Card([f])\nf = Form("f", b, [fc])\nfc = FormControl("Ticket", Input("ticket", "T-1", "text", {required: true}))\nb = Buttons([Button("Go", @ToAssistant("send answer"), "primary"), Button("Open the pull request", @OpenUrl("https://example.com/pull/1"), "secondary")])' }));
    t.focus('button:Go'); t.key('enter');
    assert.equal(t.acts.length, 0);
    assert.match(t.text(), /Error: /);
    t.focus('field:f/ticket'); t.type('T-9');
    t.focus('button:Go'); t.key('enter');
    t.focus('button:Open the pull request'); t.key('enter');
    assert.deepEqual(t.acts, [{ kind: 'assistant', message: 'send answer' }, { kind: 'url', url: 'https://example.com/pull/1' }]);
  });

  it('edits text with the keys of a terminal text box', () => {
    const t = setup(card({ id: 'e', title: 'Edit', body: 'root = Card([f])\nf = Form("f", b, [fc])\nb = Buttons([])\nfc = FormControl("Note", TextArea("note", "", 3))' }));
    t.focus('field:f/note');
    t.type('hello world'); t.key('backspace', { ctrl: true }); t.type('there'); t.key('enter'); t.type('two'); t.key('home'); t.type('> ');
    assert.equal(t.view.answer().values['note'], 'hello there\n> two');
    t.view.paste('pasted\ttext');
    assert.equal(t.view.answer().values['note'], 'hello there\n> pasted  texttwo');
  });

  it('shows a clear line with the card address for a component the terminal cannot draw', () => {
    const t = setup(card({ id: 'chart', title: 'A chart', body: 'root = Card([c])\nc = BarChart(["a", "b"], [Series("x", [1, 2])])' }));
    assert.match(t.text().replace(/\s+/g, ' '), /This card has a BarChart that the terminal cannot show\. Open the card in the browser: http:\/\/127\.0\.0\.1:4815\/#card=chart/);
  });

  it('reveals the content of a CheckWithText and keeps a prefilled value it never sends untouched', () => {
    const body = 'root = Card([f])\nf = Form("f", b, [fc])\nb = Buttons([])\nfc = FormControl("Ask for a review", ask)\nask = CheckWithText("Ask the team", check, [msg])\ncheck = CheckBoxGroup("ask_review", [yes])\nyes = CheckBoxItem("", "", "yes")\nmsg = TextArea("message", "", 6, {}, "Fixes the build.")';
    const t = setup(card({ id: 'cwt', title: 'Review', body }));
    assert.doesNotMatch(t.text(), /Fixes the build/);
    t.focus('reveal:Ask the team'); t.key('enter');
    assert.match(t.text(), /Fixes the build/);
    t.focus('field:f/ask_review'); t.key('space');
    assert.deepEqual(t.view.answer().values, { ask_review: { yes: true } });
  });

  it('builds secret, broadcast and HTML cards from forms of its own, and blocked cards from the page source', () => {
    const secret = setup(card({ id: 's', title: 'Key', kind: 'secret', secret: { name: 'API_KEY', publicKey: {} } }));
    assert.match(secret.text(), /API_KEY[\s\S]*\[ Send sealed \][\s\S]*\[ Decline \]/);
    secret.focus('field:secret/value'); secret.type('hunter2');
    assert.doesNotMatch(secret.text(), /hunter2/);
    assert.match(secret.text(), /•••••••/);
    const html = setup(card({ id: 'h', title: 'HTML', html: '<b>x</b>' }));
    assert.match(html.text(), /brings its own HTML[\s\S]*#card=h[\s\S]*\[ Send answer \]/);
    const blocked = setup(card({ id: 'b', title: 'Blocked', kind: 'blocked', screen: 'Allow?\n1. Yes\n2. No', options: [{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }] }));
    assert.match(blocked.text(), /Allow\?[\s\S]*\[ Press it in the session \][\s\S]*\[ Open session \]/);
  });
});

describe('Markdown in the card pane', () => {
  it('keeps the spaces of code, draws lists, quotes and tables, and links a session link', () => {
    const t = setup(card({ id: 'md', title: 'Markdown', text: '# Plan\n\n```\n  indented\n```\n\n- one\n- two **bold**\n\n> quoted\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOpen [the session](https://herdr.invalid/v1/tab/w1:t2) or `code`.' }));
    const text = t.text();
    assert.match(text, /│   indented/);
    assert.match(text, /• one\n• two bold/);
    assert.match(text, /│ quoted/);
    assert.match(text, /A │ B\n─+┼─+\n1 │ 2/);
    assert.match(text, /Open ❯ the session or `code`\./);
    assert.ok(t.view.stops().includes('session:https://herdr.invalid/v1/tab/w1:t2'));
  });

  it('shows a file link as its path, which the terminal can open itself, with no Tab stop', () => {
    const t = setup(card({ id: 'fl', title: 'Files', origin: { host: 'laptop' }, localFiles: true, text: 'Read [the report](file:///tmp/My%20Report.html) and file:///tmp/notes.txt.' }));
    assert.match(t.text(), /Read `\/tmp\/My Report\.html` and `\/tmp\/notes\.txt`\./);
    assert.deepEqual(t.view.stops().filter((x) => x.startsWith('url:')), []);
  });

  it('keeps a leading blank line on Ctrl+U and Home at the start of a field, and word jumps stop between graphemes', () => {
    const k = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, ...mods });
    assert.deepEqual(editKey({ value: '\nabc', cursor: 0 }, k('u', { ctrl: true }), { multiline: true, width: 20 }), { value: '\nabc', cursor: 0 });
    assert.deepEqual(editKey({ value: '\nabc', cursor: 0 }, k('home'), { multiline: true, width: 20 }), { value: '\nabc', cursor: 0 });
    const v = 'a \u0301b';
    const left = editKey({ value: v, cursor: v.length }, k('left', { ctrl: true }), { multiline: false, width: 20 })!;
    assert.equal(left.cursor, 1);
  });

  it('describes an OptionCards answer with the labels of the picks, as the page summary shows them', () => {
    const c = card({ id: 'q', title: 'Q', questions: [{ question: 'Runner?', options: [{ label: 'node:test' }] }], body: 'root = Card([f])\nf = Form("f", b, [fc])\nb = Buttons([])\nfc = FormControl("Pick", OptionCards("pick", "single", [OptionCard("a", "Alpha")]))' });
    assert.equal(describeAnswer(c, { card: 'q', version: 1, values: { pick: 'a' }, comment: '', delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [] }), 'Pick: Alpha');
  });

  it('shows a Mermaid diagram as its source, in text and in a body, and says the page draws it', () => {
    const t = setup(card({ id: 'mm', title: 'Flow', text: '```mermaid\ngraph TD\n  A-->B\n```', body: 'root = Card([d])\nd = Mermaid("sequenceDiagram\\n  A->>B: hi")' }));
    const text = t.text();
    assert.match(text, /A diagram, drawn on the page in the browser\. Its source:\n│ graph TD\n│   A-->B/);
    assert.match(text, /Its source:\n│ sequenceDiagram\n│   A->>B: hi/);
  });

  it('drops a pick for a question a revision removed, and stores no day the calendar lacks', () => {
    const t = setup(card({ id: 'rev', title: 'Rev', questions: [{ question: 'One?', options: [{ label: 'a' }] }], body: 'root = Card([f])\nf = Form("f", b, [fc])\nb = Buttons([])\nfc = FormControl("When?", DatePicker("when"))' }));
    t.view.store.set('f', 'q1', 'gone');
    t.focus('field:f/when'); t.type('2025-02-30');
    assert.deepEqual(t.view.answer().values, {});
    t.key('backspace'); t.key('backspace'); t.type('28');
    assert.equal(t.view.answer().values['when'], new Date(2025, 1, 28).toISOString());
  });

  it('stores a year under 100 as that year', () => {
    const t = setup(card({ id: 'yr', title: 'Year', body: 'root = Card([f])\nf = Form("f", b, [fc])\nb = Buttons([])\nfc = FormControl("When?", DatePicker("when"))' }));
    t.focus('field:f/when'); t.type('0042-06-15');
    const d = new Date(String(t.view.answer().values['when']));
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [42, 5, 15]);
  });

  it('draws the fallback the inbox sends for a body that does not draw whole, with the page warning', () => {
    const t = setup(card({ id: 'fb', title: 'Broken', body: 'root = Card([a, b])\na = TextContent("ok")\nb = Nope(', bodyFallback: { body: 'root = Card([a, src])\na = TextContent("ok")\nsrc = CodeBlock("text", "b = Nope(")', faults: ['b'] } }));
    const text = t.text();
    assert.match(text, /Warning: part of this card did not draw/);
    assert.match(text, /│ b = Nope\(/);
  });
});

describe('an agent reply in the terminal client', () => {
  it('draws its Markdown, as the card text does', () => {
    const t = setup(card({ id: 'rmd', title: 'Replied', replies: [{ at: 1, seenAt: null, text: '**Deployed.** See [the run](https://example.com/run).\n\n- one\n- two' }] })).text();
    assert.match(t, /Deployed\. See the run/);
    assert.doesNotMatch(t, /\*\*Deployed/);
    assert.doesNotMatch(t, /\]\(https/);
    assert.match(t, /• one|- one/);
  });
});

describe('the recommended option in the card pane', () => {
  it('tags the option the recommendation names and shows the recommendation inside it, not above the options', () => {
    const t = setup(card({ id: 'ri', title: 'Give PR CI a Datadog key?', recommendation: 'Go ahead. A **read-only** key exposes nothing.',
      options: [{ id: 'g', label: 'Go ahead', description: 'This agent adds the key.' }, { id: 'n', label: 'No Datadog key in PR CI' }] })).text();
    assert.doesNotMatch(t, /^.*Recommendation$/m);
    const lines = t.split('\n');
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    assert.ok(at(/Go ahead$/) < at(/This agent adds the key/), t);
    assert.ok(at(/This agent adds the key/) < at(/Recommended/), t);
    assert.ok(at(/Recommended/) < at(/key exposes nothing/), t);
    assert.ok(at(/key exposes nothing/) < at(/No Datadog key in PR CI/), t);
    assert.equal(lines.filter((l) => /Recommended/.test(l)).length, 1);
    // The option says "Go ahead" once: the recommendation inside it drops the label and starts with a capital.
    assert.equal(lines.filter((l) => /Go ahead/.test(l)).length, 1, t);
    assert.match(t, /A read-only key exposes nothing/);
  });

  it('tags a marked option, and keeps a recommendation that names no option in its own block', () => {
    const marked = setup(card({ id: 'rm', title: 'Merge?', options: [{ id: 'm', label: 'Merge', recommended: true }, { id: 'w', label: 'Wait' }] })).text();
    assert.ok(marked.split('\n').findIndex((l) => /Recommended/.test(l)) > marked.split('\n').findIndex((l) => /Merge$/.test(l)), marked);
    const none = setup(card({ id: 'rn', title: 'Store?', recommendation: 'SQLite, one file.', options: [{ id: 's', label: 'Use SQLite' }, { id: 'p', label: 'Use Postgres' }] })).text();
    assert.match(none, /Recommendation/);
    assert.doesNotMatch(none, /Recommended/);
  });
});
