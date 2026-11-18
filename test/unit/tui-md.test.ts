// Card text as Markdown in the terminal client: a nested list hangs under its parent item's text.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Doc } from '../../src/tui/doc.ts';
import { markdown } from '../../src/tui/md.ts';
import { makeTheme } from '../../src/tui/theme.ts';

const draw = (text: string, unicode = true): string[] => {
  const doc = new Doc(60);
  markdown(doc, text, { theme: makeTheme({ color: 0, unicode, hyperlinks: false }) });
  return doc.lines.map((l) => l.spans.map((s) => s.text).join('').trimEnd());
};

describe('nested lists in the terminal client', () => {
  it('indents each level under its parent text, with a bullet per level', () => {
    assert.deepEqual(draw('- Release checklist:\n  - the changelog\n    - names the fix\n- Then merge.'), [
      '• Release checklist:',
      '  ◦ the changelog',
      '    ▪ names the fix',
      '• Then merge.',
    ]);
    assert.deepEqual(draw('- a\n  - b', false), ['* a', '  - b']);
  });

  it('numbers an ordered list from its start, under a bullet or above one', () => {
    assert.deepEqual(draw('- Later steps\n  3. deploy\n  4. announce'), ['• Later steps', '  3. deploy', '  4. announce']);
    assert.deepEqual(draw('1. Build\n   - fast\n2. Test'), ['1. Build', '   ◦ fast', '2. Test']);
  });
});
