// Bytes from the terminal become keys, mouse events, pastes and focus changes, whichever way the terminal encodes them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decoder, type InputEvent } from '../../src/tui/input.ts';

const all = (...chunks: string[]): InputEvent[] => {
  const d = new Decoder();
  const out = chunks.flatMap((c) => d.feed(c));
  return [...out, ...d.flush()];
};
const keys = (...chunks: string[]) => all(...chunks).map((e) => (e.type === 'key' ? `${e.ctrl ? 'C-' : ''}${e.alt ? 'M-' : ''}${e.shift ? 'S-' : ''}${e.name}` : e.type));

describe('input decoding', () => {
  it('reads plain keys, control keys and the legacy arrows', () => {
    assert.deepEqual(keys('a', ' ', 'Z', '\r', '\t', '\x7f', '\x1b[Z', '\x03', '\x13', '\x1b[A', '\x1bOB', '\x1b[5~', '\x1b[1;5C'),
      ['a', 'space', 'S-Z', 'enter', 'tab', 'backspace', 'S-tab', 'C-c', 'C-s', 'up', 'down', 'pageup', 'C-right']);
  });

  it('reads Ctrl+Enter in the kitty keyboard protocol and in xterm modifyOtherKeys', () => {
    assert.deepEqual(keys('\x1b[13;5u', '\x1b[27;5;13~', '\x1b[99;5u', '\x1b[27u', '\x1b[97;3u', '\x1b[13u'), ['C-enter', 'C-enter', 'C-c', 'escape', 'M-a', 'enter']);
  });

  it('tells Escape alone from the start of a sequence, and Alt from a character after Escape', () => {
    assert.deepEqual(keys('\x1b'), ['escape']);
    assert.deepEqual(keys('\x1bx'), ['M-x']);
    // A sequence split across reads stays one key.
    assert.deepEqual(keys('\x1b[', '1;5', 'A'), ['C-up']);
  });

  it('reads SGR mouse presses, releases, drags and the wheel, at zero-based cells', () => {
    const ev = all('\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[<32;11;5M', '\x1b[<64;3;4M', '\x1b[<65;3;4M', '\x1b[<4;1;1M');
    assert.deepEqual(ev.map((e) => (e.type === 'mouse' ? [e.action, e.button, e.x, e.y, e.shift] : e.type)), [
      ['down', 0, 9, 4, false], ['up', 0, 9, 4, false], ['drag', 0, 10, 4, false], ['wheel-up', 0, 2, 3, false], ['wheel-down', 0, 2, 3, false], ['down', 0, 0, 0, true],
    ]);
  });

  it('keeps a bracketed paste as one piece of text, even across reads and with control characters inside', () => {
    const ev = all('\x1b[200~line one\r\nline', ' two\x1b[201~', 'x');
    assert.equal(ev[0]?.type === 'paste' && ev[0].text, 'line one\nline two');
    assert.equal(ev[1]?.type === 'key' && ev[1].name, 'x');
  });

  it('reports focus changes and the terminal replies the client asked for', () => {
    const ev = all('\x1b[I', '\x1b[O', '\x1b[?1u', '\x1b[?62;22c');
    assert.deepEqual(ev.map((e) => (e.type === 'focus' ? `focus:${e.on}` : e.type === 'reply' ? `reply:${e.kind}` : e.type)), ['focus:true', 'focus:false', 'reply:kitty', 'reply:attributes']);
  });

  it('reads typed text with accents and emoji as keys with their text', () => {
    const ev = all('é👍');
    assert.deepEqual(ev.map((e) => e.type === 'key' && e.text), ['é', '👍']);
  });

  it('drops a key release and a code point past Unicode, instead of reading them as presses or throwing', () => {
    assert.deepEqual(keys('\x1b[1;1:3A', '\x1b[3;1:3~', '\x1b[97;1:3u', 'x'), ['x']);
    assert.deepEqual(keys('\x1b[1114112u', '\x1b[27;5;1114112~'), ['unknown', 'C-unknown']);
  });

  it('names Alt+Space space', () => {
    assert.deepEqual(keys('\x1b '), ['M-space']);
  });
});
