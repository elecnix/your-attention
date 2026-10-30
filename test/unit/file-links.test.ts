// The inbox serves a file only when the card names it, so every path the page links must be one the inbox finds.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileLinkPaths } from '../../src/core/file-links.ts';
import { renderMarkdown } from '../../web/markdown.js';

const TEXTS = [
  'Read file:///tmp/report.html.',
  'See [the report](file:///tmp/r.html) and file:///tmp/My%20Notes.md, then (file:///tmp/in-parens.txt).',
  'file://localhost/tmp/local.txt and file://server/share/x and [y](file:relative)',
  'Traversal: file:///tmp/a/../b.txt',
  '`file:///tmp/in-code.txt` is code, not a link',
  'Capitals: [x](FILE:///tmp/up.txt)',
];

/** The paths the page hands to its fileLink option. */
function pagePaths(text: string): string[] {
  const paths: string[] = [];
  const h = (_t: string, _p: unknown, ...children: unknown[]) => children;
  renderMarkdown(h, text, { fileLink: (path: string) => { paths.push(path); return path; } });
  return paths;
}

describe('file links in a card', () => {
  it('finds each local file address, decoded, with dot segments resolved', () => {
    assert.deepEqual(fileLinkPaths(TEXTS[1]!), ['/tmp/r.html', '/tmp/My Notes.md', '/tmp/in-parens.txt']);
    assert.deepEqual(fileLinkPaths(TEXTS[2]!), ['/tmp/local.txt']);
    assert.deepEqual(fileLinkPaths(TEXTS[3]!), ['/tmp/b.txt']);
  });

  it('finds every path the page links, in every text', () => {
    for (const t of TEXTS) for (const p of pagePaths(t)) assert.ok(fileLinkPaths(t).includes(p), `${p} in ${t}`);
    assert.deepEqual(pagePaths(TEXTS[1]!), ['/tmp/r.html', '/tmp/My Notes.md', '/tmp/in-parens.txt']);
  });

  it('also finds an address inside code, which the agent named all the same', () => {
    assert.deepEqual(fileLinkPaths(TEXTS[4]!), ['/tmp/in-code.txt']);
  });
});
