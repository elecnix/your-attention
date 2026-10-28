import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error The page's renderer is plain JavaScript.
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
