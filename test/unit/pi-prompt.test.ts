// What a prompt card says, what the person typed on it, and whether the prompt still waits on the screen.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promptOnScreen, promptText, typedAnswer } from '../../src/integrations/pi/prompt.ts';
import type { Answer } from '../../src/core/types.ts';

const answer = (comment: string, values: Record<string, unknown> = {}): Answer => ({ comment, values } as Answer);

const SCREEN = [
  '╭──────────────────────────╮',
  '│ Pick a database          │',
  '│ ❯ SQLite                 │',
  '╰──────────────────────────╯',
].join('\n');

describe('what a prompt card says', () => {
  it('names the session, the prompt and the pane it can be answered in', () => {
    const text = promptText({ name: 'card inbox', session: 'pi-1' }, { kind: 'select', title: 'Pick a database' }, 'w7:p1');
    assert.match(text, /^card inbox \(pi-1\) is waiting at the select prompt: "Pick a database"\./);
    assert.match(text, /types it into the pane/);
  });

  it('says a session with no pane cannot take an answer from the card', () => {
    const text = promptText({ session: 'pi-1' }, { kind: 'custom' }, undefined);
    assert.match(text, /^pi-1 is waiting at the custom prompt\./);
    assert.match(text, /runs outside a herdr pane/);
  });
});

describe('the answer the person typed on a prompt card', () => {
  it('is the comment, or the value the answer carries instead', () => {
    assert.equal(typedAnswer(answer(' SQLite ')), 'SQLite');
    assert.equal(typedAnswer(answer('', { text: ' Postgres ' })), 'Postgres');
    assert.equal(typedAnswer(answer('  ', {})), '');
  });
});

describe('whether the prompt still waits on the screen', () => {
  it('is true while the screen shows the prompt title, and false once it loses it', () => {
    assert.equal(promptOnScreen({ title: 'Pick a database' }, SCREEN), true);
    assert.equal(promptOnScreen({ title: 'Pick a database' }, 'Running the migration…'), false);
  });

  it('is false for a pane that reads nothing, and true for a prompt with no title while its span is open', () => {
    assert.equal(promptOnScreen({ title: 'Pick a database' }, ''), false);
    assert.equal(promptOnScreen({}, SCREEN), true);
  });
});
