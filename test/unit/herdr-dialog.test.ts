import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDialog } from '../../src/integrations/herdr/dialog.ts';

const CLAUDE_PERMISSION = `
 Bash command
   rm -rf build
   Remove the build directory

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /work
   3. No, and tell Claude what to do differently (esc)
`;

const CLAUDE_QUESTION = `
 ☐ Database
 Which database should the cache use?
 ❯ 1. SQLite
      Small and embedded
   2. Postgres
      Already in production
   3. Type something.
 Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const CODEX_APPROVAL = `
  Would you like to run the following command?
  $ rm -rf build
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (p)
  3. No, and tell Codex what to do differently (esc)
`;

describe('reading a dialog from an agent screen', () => {
  it('reads a Claude Code permission prompt', () => {
    assert.deepEqual(parseDialog(CLAUDE_PERMISSION), {
      question: 'Do you want to proceed?',
      options: [
        { key: '1', label: 'Yes' },
        { key: '2', label: "Yes, and don't ask again for rm commands in /work" },
        { key: '3', label: 'No, and tell Claude what to do differently (esc)' },
      ],
    });
  });

  it('reads a question, and leaves out the option that needs typed text', () => {
    assert.deepEqual(parseDialog(CLAUDE_QUESTION), {
      question: 'Which database should the cache use?',
      options: [{ key: '1', label: 'SQLite' }, { key: '2', label: 'Postgres' }],
    });
  });

  it('reads a Codex approval prompt', () => {
    assert.deepEqual(parseDialog(CODEX_APPROVAL)?.options.map((o) => o.key), ['1', '2', '3']);
    assert.equal(parseDialog(CODEX_APPROVAL)?.question, 'Would you like to run the following command?\n$ rm -rf build');
  });

  it('finds no dialog on a screen without numbered choices, or with one choice only', () => {
    assert.equal(parseDialog('Thinking…\n> '), undefined);
    assert.equal(parseDialog('Steps:\n1. Build it\nDone.'), undefined);
    assert.equal(parseDialog('Steps:\n1. Build\n3. Test'), undefined, 'numbers that skip are a list, not a dialog');
  });
});
