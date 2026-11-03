// The diff a guidance card shows: the proposed text against the current guidance, line by line in order, with the
// changed words marked. The page and the terminal client both draw it from guidanceDiff in web/answers.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guidanceDiff } from '../../web/answers.js';

const marks = (words: [string, boolean][] | undefined) => (words ?? []).filter(([w, changed]) => changed && w.trim()).map(([w]) => w);

describe('guidanceDiff', () => {
  it('keeps the unchanged lines in order, adds a line, and pairs an edited line with the words that changed', () => {
    const rows = guidanceDiff('Lead with the goal.\nGive two options.\nEnd with a recommendation.', 'Lead with the goal.\nGive three options.\nEnd with a recommendation.\nAttach a screenshot.');
    assert.deepEqual(rows.map((r) => [r.kind, r.text]), [
      ['same', 'Lead with the goal.'],
      ['del', 'Give two options.'],
      ['add', 'Give three options.'],
      ['same', 'End with a recommendation.'],
      ['add', 'Attach a screenshot.'],
    ]);
    assert.deepEqual(marks(rows[1]?.words), ['two']);
    assert.deepEqual(marks(rows[2]?.words), ['three']);
    assert.equal(rows[4]?.words, undefined, 'a line with no removed partner gets no word marks');
  });

  it('marks a removed line that the proposal never saw, because the guidance changed after the agent proposed', () => {
    const base = 'Lead with the goal.';
    const current = 'Lead with the goal.\nName the files.';
    const rows = guidanceDiff(current, 'Lead with the goal.\nAttach a screenshot.', base);
    const undone = rows.filter((r) => r.undone).map((r) => r.text);
    assert.deepEqual(undone, ['Name the files.']);
  });

  it('marks the second copy of a line that the guidance gained after the proposal', () => {
    const rows = guidanceDiff('Lead with the goal.\nName the files.\nName the files.', 'Lead with the goal.\nName the files.', 'Lead with the goal.\nName the files.');
    assert.deepEqual(rows.filter((r) => r.kind === 'del').map((r) => [r.text, !!r.undone]), [['Name the files.', true]]);
  });

  it('marks nothing as undone when the guidance has not changed since the proposal', () => {
    const rows = guidanceDiff('A.\nB.', 'A.', 'A.\nB.');
    assert.equal(rows.some((r) => r.undone), false);
  });
});
