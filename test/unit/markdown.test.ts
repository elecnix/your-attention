import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../../web/markdown.js';

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
