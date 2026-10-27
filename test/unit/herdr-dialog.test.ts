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
      context: ['Bash command', 'rm -rf build', 'Remove the build directory', 'Do you want to proceed?'],
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
      context: ['Which database should the cache use?'],
      options: [{ key: '1', label: 'SQLite' }, { key: '2', label: 'Postgres' }],
    });
  });

  it('reads a Codex approval prompt', () => {
    assert.deepEqual(parseDialog(CODEX_APPROVAL)?.options.map((o) => o.key), ['1', '2', '3']);
    assert.equal(parseDialog(CODEX_APPROVAL)?.question, 'Would you like to run the following command?\n$ rm -rf build');
  });

  it('reads a real Claude Code permission box, with its command as context', () => {
    const screen = [
      '❯ Run the probe', '', '  Creating probe directory', '  ⎿  $ mkdir -p /tmp/probe', '',
      '─'.repeat(60), ' Bash command', ' Create probe directory', '╌'.repeat(60), ' mkdir -p /tmp/probe', '╌'.repeat(60),
      ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend',
    ].join('\n');
    const d = parseDialog(screen);
    assert.equal(d?.question, 'Do you want to proceed?');
    assert.deepEqual(d?.context, ['Bash command', 'Create probe directory', 'mkdir -p /tmp/probe', 'Do you want to proceed?']);
  });

  it('takes the block before a blank line when nothing sits right above the choices', () => {
    const d = parseDialog('  WARNING: Loading development channels\n\n  Channels: server:x\n\n  ❯ 1. I am using this for local development\n    2. Exit');
    assert.equal(d?.question, 'Channels: server:x');
  });

  it('reads a tall box to its top border, and a box with rounded corners', () => {
    const tall = ['─'.repeat(40), ' Bash command', ...Array.from({ length: 20 }, (_, i) => ` line ${i}`), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
    assert.equal(parseDialog(tall)?.context.length, 22);
    const rounded = ['earlier output', '╭' + '─'.repeat(30) + '╮', '│ Allow the edit?             │', '│ ❯ 1. Yes                     │', '│   2. No                      │', '╰' + '─'.repeat(30) + '╯'].join('\n');
    const d = parseDialog(rounded);
    assert.deepEqual(d?.context, ['Allow the edit?']);
  });

  it('never merges the dialog with numbered lines far below it', () => {
    const screen = ' Pick one?\n ❯ 1. Red\n   2. Blue\n\n Earlier output:\n step done\n more output\n   3. Green';
    assert.deepEqual(parseDialog(screen)?.options.map((o) => o.label), ['Red', 'Blue']);
  });

  it('finds no dialog on a screen without numbered choices, or with one choice only', () => {
    assert.equal(parseDialog('Thinking…\n> '), undefined);
    assert.equal(parseDialog('Steps:\n1. Build it\nDone.'), undefined);
    assert.equal(parseDialog('Steps:\n1. Build\n3. Test'), undefined, 'numbers that skip are a list, not a dialog');
  });
});
