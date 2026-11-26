import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LINK_TARGET, renderMarkdown } from '../../web/markdown.js';

type Node = { type: string; children: unknown[] };
const h = (type: string, _props: unknown, ...children: unknown[]): Node => ({ type, children: children.flat() });
/** The text inside each element of one type, in order. */
const texts = (src: string, type: string): string[] => {
  const found: string[] = [];
  const text = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? (n as Node).children.map(text).join('') : '');
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ((n as Node).type === type) found.push(text(n));
    (n as Node).children.forEach(walk);
  };
  walk(renderMarkdown(h, src));
  return found;
};

describe('emphasis with underscores, as CommonMark reads it', () => {
  it('starts a table right after a line of text, with no blank line between them', () => {
    const src = '**What it does today**\n| Step | Tool |\n|---|---|\n| Find | lexicon |';
    assert.deepEqual(texts(src, 'p'), ['What it does today']);
    assert.deepEqual(texts(src, 'th'), ['Step', 'Tool']);
    assert.deepEqual(texts(src, 'td'), ['Find', 'lexicon']);
  });

  it('leaves underscores inside a word alone', () => {
    assert.deepEqual(texts('The switch key in the MY_SERVICE_API_KEY environment variable', 'em'), []);
    assert.deepEqual(texts('snake_case and foo_bar_baz', 'em'), []);
  });

  it('still makes emphasis from underscores around words, and from stars inside a word', () => {
    assert.deepEqual(texts('Read _this part_ first.', 'em'), ['this part']);
    assert.deepEqual(texts('(_quoted_)', 'em'), ['quoted']);
    assert.deepEqual(texts('un*frigging*believable', 'em'), ['frigging']);
  });

  it('needs the text right inside the underscores', () => {
    assert.deepEqual(texts('a _ b _ c', 'em'), []);
  });
});

describe('the scan after an underscore that is not emphasis', () => {
  it('still finds emphasis that starts at the rejected closing underscore', () => {
    assert.deepEqual(texts('a_b _c_ d', 'em'), ['c']);
  });

  it('uses no regex lookbehind, which some phone browsers cannot parse', async () => {
    const fs = await import('node:fs');
    assert.equal(/\(\?<[=!]/.test(fs.readFileSync(new URL('../../web/markdown.js', import.meta.url), 'utf8')), false);
  });
});

describe('file links', () => {
  type El = { type: string; props: Record<string, unknown>; children: unknown[] };
  const el = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children: children.flat() });
  const walk = (n: unknown, found: El[] = []): El[] => {
    if (Array.isArray(n)) n.forEach((c) => walk(c, found));
    else if (n && typeof n === 'object') { found.push(n as El); (n as El).children.forEach((c) => walk(c, found)); }
    return found;
  };
  const codes = (src: string): string[] => walk(renderMarkdown(el, src)).filter((n) => n.type === 'code').map((n) => n.children.join(''));
  const linked = (src: string): [string, string][] => {
    const calls: [string, string][] = [];
    renderMarkdown(el, src, { fileLink: (path: string, label: string, key: string) => { calls.push([path, label]); return el('a', { key, href: path }, label); } });
    return calls;
  };

  it('shows a bare file address as code with its path, and leaves the closing period of a sentence out', () => {
    assert.deepEqual(codes('Read file:///tmp/report.html.'), ['/tmp/report.html']);
    assert.deepEqual(texts('Read file:///tmp/report.html.', 'p'), ['Read /tmp/report.html.']);
  });

  it('decodes the path, so the code shows the name a person reads', () => {
    assert.deepEqual(codes('file:///tmp/My%20Report.html'), ['/tmp/My Report.html']);
  });

  it('shows a Markdown link to a file address as code with its path', () => {
    assert.deepEqual(codes('See [the report](file:///tmp/r.html) now.'), ['/tmp/r.html']);
  });

  it('hands each file link to the fileLink option, with its path and its label', () => {
    assert.deepEqual(linked('See [the report](file:///tmp/r.html) and file:///tmp/My%20Notes.md.'), [['/tmp/r.html', 'the report'], ['/tmp/My Notes.md', '/tmp/My Notes.md']]);
  });

  it('leaves an address that names another host, or is not a file path, as text', () => {
    assert.deepEqual(codes('file://server/share/x and [y](file:relative)'), []);
    assert.deepEqual(linked('file://server/share/x and [y](file:relative)'), []);
  });

  it('keeps a file address inside a code span as written', () => {
    assert.deepEqual(codes('`file:///tmp/a`'), ['file:///tmp/a']);
  });
});

describe('fenced code', () => {
  type El = { type: string; props: Record<string, unknown>; children: unknown[] };
  const el = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children: children.flat() });

  it('puts a Copy button beside the block, and keeps the text exactly as written', () => {
    const block = (renderMarkdown(el, '```sh\nnpm test\n  --watch\n```') as El[])[0]!;
    assert.equal(block.props['className'], 'code-block');
    const [button, pre] = block.children as [El, El];
    assert.equal(button.type, 'button');
    assert.equal(button.props['type'], 'button');
    assert.equal(button.props['aria-label'], 'Copy');
    assert.equal(pre.type, 'pre');
    assert.deepEqual((pre.children[0] as El).children, ['npm test\n  --watch']);
  });

  it('draws a Mermaid block with the diagram option, with no Copy button', () => {
    const blocks = renderMarkdown(el, '```mermaid\nflowchart TD\n  A --> B\n```', { diagram: (source: string) => el('figure', null, source) }) as El[];
    assert.deepEqual(blocks.map((b) => b.type), ['figure']);
  });
});

describe('nested lists, by indentation as CommonMark reads them', () => {
  type El = { type: string; props: Record<string, unknown>; children: unknown[] };
  const el = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children: children.flat() });
  /** A list as a plain outline: each list is its tag (with its start when it has one) and its items, each item its own text and its child lists. */
  type Outline = { list: string; items: { text: string; lists: Outline[] }[] };
  const textOf = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? (n as El).children.map(textOf).join('') : '');
  const isList = (n: unknown): n is El => !!n && typeof n === 'object' && ['ul', 'ol'].includes((n as El).type);
  const outline = (list: El): Outline => ({
    list: list.type + (list.props['start'] !== undefined ? `@${list.props['start']}` : ''),
    items: (list.children as El[]).map((li) => ({
      text: li.children.filter((c) => !isList(c)).map(textOf).join(''),
      lists: li.children.filter(isList).map(outline),
    })),
  });
  const lists = (src: string): Outline[] => (renderMarkdown(el, src) as El[]).filter(isList).map(outline);
  const leaf = (text: string) => ({ text, lists: [] });

  it('nests items indented two spaces under a dash', () => {
    assert.deepEqual(lists('- Fruit\n  - apple\n  - pear\n- Bread'), [
      { list: 'ul', items: [{ text: 'Fruit', lists: [{ list: 'ul', items: [leaf('apple'), leaf('pear')] }] }, leaf('Bread')] },
    ]);
  });

  it('nests items indented four spaces, and a tab, as deeper children', () => {
    const want = [{ list: 'ul', items: [{ text: 'Fruit', lists: [{ list: 'ul', items: [leaf('apple')] }] }] }];
    assert.deepEqual(lists('- Fruit\n    - apple'), want);
    assert.deepEqual(lists('- Fruit\n\t- apple'), want);
  });

  it('measures a tab from its own column when the parent item does not start at column 0', () => {
    // The tab starts at column 2, under b's text column, so it stops at column 4, and cont at column 6 continues c.
    assert.deepEqual(lists('- a\n  - b\n  \t- c\n      cont'), [
      { list: 'ul', items: [{ text: 'a', lists: [{ list: 'ul', items: [{ text: 'b', lists: [{ list: 'ul', items: [leaf('c cont')] }] }] }] }] },
    ]);
    // A tab after a nested marker counts from the marker's own column too.
    assert.deepEqual(lists('- a\n  -\tb\n    cont'), [{ list: 'ul', items: [{ text: 'a', lists: [{ list: 'ul', items: [leaf('b cont')] }] }] }]);
  });

  it('nests three levels', () => {
    assert.deepEqual(lists('- one\n  - two\n    - three\n- four'), [
      { list: 'ul', items: [{ text: 'one', lists: [{ list: 'ul', items: [{ text: 'two', lists: [{ list: 'ul', items: [leaf('three')] }] }] }] }, leaf('four')] },
    ]);
  });

  it('nests a numbered list under a bullet, and bullets under a number, which needs three spaces', () => {
    assert.deepEqual(lists('- Steps\n  1. build\n  2. test'), [
      { list: 'ul', items: [{ text: 'Steps', lists: [{ list: 'ol', items: [leaf('build'), leaf('test')] }] }] },
    ]);
    assert.deepEqual(lists('1. Build\n   - fast\n2. Test'), [
      { list: 'ol', items: [{ text: 'Build', lists: [{ list: 'ul', items: [leaf('fast')] }] }, leaf('Test')] },
    ]);
  });

  it('keeps a numbered list sibling, not child, when it sits under the number by fewer columns than the number takes', () => {
    assert.deepEqual(lists('1. Build\n  - fast'), [{ list: 'ol', items: [leaf('Build')] }, { list: 'ul', items: [leaf('fast')] }]);
  });

  it('keeps the start number of an ordered list', () => {
    assert.deepEqual(lists('3. three\n4. four'), [{ list: 'ol@3', items: [leaf('three'), leaf('four')] }]);
    assert.deepEqual(lists('- Later steps\n  3. deploy'), [{ list: 'ul', items: [{ text: 'Later steps', lists: [{ list: 'ol@3', items: [leaf('deploy')] }] }] }]);
  });

  it('continues the parent list with a sibling after a nested block', () => {
    assert.deepEqual(lists('1. a\n   - a1\n   - a2\n2. b\n3. c'), [
      { list: 'ol', items: [{ text: 'a', lists: [{ list: 'ul', items: [leaf('a1'), leaf('a2')] }] }, leaf('b'), leaf('c')] },
    ]);
  });

  it('starts a new list when the marker changes between bullets and numbers at one level', () => {
    assert.deepEqual(lists('- a\n1. b'), [{ list: 'ul', items: [leaf('a')] }, { list: 'ol', items: [leaf('b')] }]);
  });

  it('adds an indented line that is not a marker to the item above it', () => {
    assert.deepEqual(lists('- Fruit\n  ripe ones only\n- Bread'), [{ list: 'ul', items: [leaf('Fruit ripe ones only'), leaf('Bread')] }]);
    assert.deepEqual(texts('- Fruit\nNot in the list.', 'p'), ['Not in the list.']);
  });

  it('keeps one list across a blank line between its items, and its numbers run on', () => {
    assert.deepEqual(lists('1. a\n\n2. b'), [{ list: 'ol', items: [leaf('a'), leaf('b')] }]);
  });

  it('draws inline Markdown and card links inside a nested item', () => {
    const blocks = renderMarkdown(el, '- Top\n  - **bold** and [[abc]]', { cardLink: (id: string, key: string) => el('cardlink', { key }, id) });
    const inner = ((blocks[0] as El).children[0] as El).children.find(isList)!;
    const li = inner.children[0] as El;
    assert.deepEqual(li.children.map((c) => (typeof c === 'string' ? c : (c as El).type)), ['strong', ' and ', 'cardlink']);
  });

  it('draws the nested list of card 433cac13aa635646 as a list inside its item', () => {
    const src = [
      'Before I merge, three checks remain:',
      '',
      '- Release checklist:',
      '  - the changelog names the fix',
      '  - CI is green on main',
      '  - the tag matches package.json',
      '- Then I post the merge card.',
    ].join('\n');
    assert.deepEqual(texts(src, 'p'), ['Before I merge, three checks remain:']);
    assert.deepEqual(lists(src), [{ list: 'ul', items: [
      { text: 'Release checklist:', lists: [{ list: 'ul', items: [leaf('the changelog names the fix'), leaf('CI is green on main'), leaf('the tag matches package.json')] }] },
      leaf('Then I post the merge card.'),
    ] }]);
  });
});

describe("the links the page draws, which the triage agent's Links check reads too", () => {
  it('draws a link to an http, https or mailto address, and hears a link to anything else as a label alone', () => {
    for (const target of ['https://ci.test/run', 'http://ci.test', 'mailto:me@example.test']) {
      assert.equal(LINK_TARGET.test(target), true, target);
      const heard: string[] = [];
      const src = `See [the run](${target}).`;
      renderMarkdown(h, src, { unlinked: (label, t) => heard.push(`${label} ${t}`) });
      assert.deepEqual(heard, [], target);
      assert.deepEqual(texts(src, 'a'), ['the run'], target);
    }
    for (const target of ['/run/17', 'acme/api#42', 'ci.test/run']) {
      assert.equal(LINK_TARGET.test(target), false, target);
      const heard: { label: string; target: string }[] = [];
      renderMarkdown(h, `See [the run](${target}).`, { unlinked: (label, t) => heard.push({ label, target: t }) });
      assert.deepEqual(heard, [{ label: 'the run', target }], target);
      assert.deepEqual(texts(`See [the run](${target}).`, 'a'), [], target);
    }
  });
});
