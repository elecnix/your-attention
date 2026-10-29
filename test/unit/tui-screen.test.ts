// The cell grid and what it writes to the terminal: only the cells that changed, in the colors the terminal supports.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Grid, encodeFrame, sgrColor, type Caps } from '../../src/tui/screen.ts';
import { Vt } from '../vt.ts';

const caps = (color: Caps['color']): Caps => ({ color, unicode: true, hyperlinks: true });

describe('the cell grid', () => {
  it('draws text, wide characters and styles, and the terminal shows the same screen', () => {
    const g = new Grid(20, 3);
    g.text(0, 0, 'hello', { bold: true });
    g.text(0, 1, '日本 ok', {});
    g.text(15, 2, 'cut here', { inverse: true });
    const vt = new Vt(20, 3);
    vt.write(encodeFrame(null, g, caps(3)));
    assert.deepEqual(vt.lines(), ['hello', '日本 ok', '               cut h']);
    assert.equal(vt.cell(0, 0)?.bold, true);
    assert.equal(vt.cell(1, 0)?.bold, true);
    assert.equal(vt.cell(5, 0)?.bold, false);
    assert.equal(vt.cell(16, 2)?.inverse, true);
  });

  it('leaves a space where a wide character would cross the right edge', () => {
    const g = new Grid(5, 1);
    assert.equal(g.text(0, 0, 'ab日本', {}), 5);
    const vt = new Vt(5, 1);
    vt.write(encodeFrame(null, g, caps(3)));
    assert.deepEqual(vt.lines(), ['ab日']);
    g.clear();
    g.text(3, 0, '日本', {}, 5);
    vt.write(encodeFrame(null, g, caps(3)));
    assert.equal(vt.lines()[0], '   日');
  });

  it('writes only the rows that changed, and from the first changed cell', () => {
    const a = new Grid(30, 4);
    a.text(0, 0, 'first row', {});
    a.text(0, 1, 'second row', {});
    a.text(0, 3, 'last row', {});
    const b = a.clone();
    b.text(7, 1, 'ROW', {});
    const out = encodeFrame(a, b, caps(3));
    assert.match(out, /\x1b\[2;8H/);
    assert.doesNotMatch(out, /first|last/);
    const vt = new Vt(30, 4);
    vt.write(encodeFrame(null, a, caps(3)));
    vt.write(out);
    assert.equal(vt.lines()[1], 'second ROW');
    assert.equal(encodeFrame(b, b.clone(), caps(3)), '');
  });

  it('writes colors in the depth the terminal supports, and none in monochrome', () => {
    assert.equal(sgrColor('#e5484d', 3, false), '38;2;229;72;77');
    assert.equal(sgrColor('#e5484d', 2, false), '38;5;167');
    assert.equal(sgrColor('#e5484d', 1, false), '91');
    assert.equal(sgrColor('#e5484d', 0, false), '');
    assert.equal(sgrColor(4, 1, true), '44');
    const g = new Grid(4, 1);
    g.text(0, 0, 'red', { fg: '#e5484d', bold: true });
    assert.doesNotMatch(encodeFrame(null, g, caps(0)), /38;|\x1b\[[\d;]*3\dm/);
    assert.match(encodeFrame(null, g, caps(0)), /\x1b\[0;1m/);
  });

  it('wraps a link in an OSC 8 hyperlink when the terminal takes them', () => {
    const g = new Grid(10, 1);
    g.text(0, 0, 'link', { link: 'https://example.com/a' });
    const vt = new Vt(10, 1);
    vt.write(encodeFrame(null, g, caps(3)));
    assert.equal(vt.cell(0, 0)?.link, 'https://example.com/a');
    assert.equal(vt.cell(5, 0)?.link, null);
    assert.doesNotMatch(encodeFrame(null, g, { ...caps(3), hyperlinks: false }), /\x1b\]8/);
  });

  it('finds text after a wide character at its own column, in the test emulator', () => {
    const vt = new Vt(10, 1);
    vt.write('日b');
    assert.deepEqual(vt.find('b'), { x: 2, y: 0 });
  });

  it('blanks both halves of a wide character that a fill cuts', () => {
    const g = new Grid(4, 1);
    g.text(0, 0, '日b', {});
    g.fill(1, 0, 1, 'x');
    assert.equal(g.row(0), ' xb ');
  });

  it('blanks the other half of a wide character that text writes over', () => {
    const g = new Grid(4, 1);
    g.text(0, 0, '日x', {});
    g.text(0, 0, 'a', {});
    assert.equal(g.row(0), 'a x ');
    const vt = new Vt(4, 1);
    vt.write('a\x7fb');
    assert.equal(vt.lines()[0], 'ab');
  });

  it('keeps one grapheme per cell through an empty fill and a wide character cut at the edge', () => {
    const g = new Grid(5, 1);
    g.text(2, 0, '日', {});
    g.fill(3, 0, 0, 'x');
    assert.equal(g.row(0), '  日 ');
    g.text(3, 0, '日', {}, 4);
    assert.equal(g.row(0), '     ');
  });

  it('leaves no orphan half when a wide character overwrites the first half of another', () => {
    const g = new Grid(6, 1);
    g.text(1, 0, '日x', {});
    g.text(0, 0, '日', {});
    g.text(3, 0, 'y', {});
    const vt = new Vt(6, 1);
    vt.write(encodeFrame(null, g, caps(3)));
    assert.equal(vt.lines()[0], '日 y');
  });
});
