// A click on a diagram opens it full screen. These are the parts that decide its size and copy its SVG, without a browser.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { naturalSize, zoomSize, zoomedSvg } from '../../web/zoom.js';

const svg = (id: string, viewBox: string) =>
  `<svg id="${id}" width="100%" viewBox="${viewBox}" style="max-width: 300px;"><style>#${id} .node rect{fill:red}</style>`
  + `<defs><marker id="${id}_flowchart-pointEnd"/></defs><path marker-end="url(#${id}_flowchart-pointEnd)"/></svg>`;

describe('naturalSize', () => {
  it('reads the width and height of the viewBox mermaid writes', () => {
    assert.deepEqual(naturalSize(svg('diagram-3', '-8 -8 300.5 120')), { width: 300.5, height: 120 });
  });
  it('reads a viewBox separated by commas', () => {
    assert.deepEqual(naturalSize('<svg viewBox="0,0,40,20"></svg>'), { width: 40, height: 20 });
  });
  it('answers null for an SVG with no usable viewBox', () => {
    assert.equal(naturalSize('<svg width="10"></svg>'), null);
    assert.equal(naturalSize('<svg viewBox="0 0 0 20"></svg>'), null);
    assert.equal(naturalSize(''), null);
  });
});

describe('zoomSize', () => {
  const screen = { width: 1000, height: 800 };
  it('grows a small diagram until it meets an edge of the screen, keeping its shape', () => {
    assert.deepEqual(zoomSize({ width: 200, height: 100 }, screen), { width: 1000, height: 500 });
    assert.deepEqual(zoomSize({ width: 100, height: 200 }, screen), { width: 400, height: 800 });
  });
  it('never shrinks a diagram below its own size, so its text stays as large as the page text, and the screen scrolls it', () => {
    assert.deepEqual(zoomSize({ width: 2000, height: 400 }, screen), { width: 2000, height: 400 });
    assert.deepEqual(zoomSize({ width: 300, height: 3000 }, screen), { width: 300, height: 3000 });
    assert.deepEqual(zoomSize({ width: 2000, height: 6000 }, screen), { width: 2000, height: 6000 });
  });
  it('grows a diagram wider than the screen is tall only to the height, keeping its aspect ratio', () => {
    assert.deepEqual(zoomSize({ width: 900, height: 200 }, { width: 390, height: 844 }), { width: 900, height: 200 });
    assert.deepEqual(zoomSize({ width: 400, height: 500 }, screen), { width: 640, height: 800 });
  });
  it('rounds to whole pixels', () => {
    assert.deepEqual(zoomSize({ width: 300, height: 7 }, { width: 1000, height: 800 }), { width: 1000, height: 23 });
  });
});

describe('zoomedSvg', () => {
  it('renames the SVG id and every reference to it, so the copy keeps its styles and arrowheads apart from the card', () => {
    const out = zoomedSvg(svg('diagram-3', '0 0 300 120'));
    assert.match(out, /^<svg id="diagram-3-zoom"/);
    assert.match(out, /#diagram-3-zoom \.node rect/);
    assert.match(out, /<marker id="diagram-3-zoom_flowchart-pointEnd"/);
    assert.match(out, /url\(#diagram-3-zoom_flowchart-pointEnd\)/);
    assert.doesNotMatch(out, /diagram-3[^-]/);
  });
  it('leaves an id that only starts with the same digits alone', () => {
    const out = zoomedSvg(`${svg('diagram-3', '0 0 1 1')}<g id="diagram-30"/>`);
    assert.match(out, /id="diagram-30"/);
  });
  it('returns an SVG with no id unchanged', () => {
    assert.equal(zoomedSvg('<svg viewBox="0 0 1 1"></svg>'), '<svg viewBox="0 0 1 1"></svg>');
  });
});
