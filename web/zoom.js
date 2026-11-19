// A click on a diagram opens it full screen. This file decides the size it opens at and copies its SVG. The page uses it,
// and the unit tests read it without a browser.

/** The width and height of a mermaid SVG, from its viewBox, or null when it has none to read. */
export function naturalSize(svg) {
  const box = /<svg\b[^>]*\sviewBox="([^"]*)"/.exec(svg || '');
  if (!box) return null;
  const [, , width, height] = box[1].trim().split(/[\s,]+/).map(Number);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The size a diagram of `natural` size opens at on a `screen`. It keeps its aspect ratio and grows until it meets an edge
 * of the screen. It never opens below its own size, where mermaid's text reads at the page's size: a diagram larger than the
 * screen opens at that size, and the screen scrolls it. */
export function zoomSize(natural, screen) {
  const scale = Math.max(Math.min(screen.width / natural.width, screen.height / natural.height), 1);
  return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
}

/** The SVG with its id, and every reference to it, renamed. Mermaid's styles and arrowheads name the SVG's id, so the
 * full-screen copy and the card's own SVG keep theirs apart. */
export function zoomedSvg(svg) {
  const id = /^<svg\b[^>]*\sid="([^"]+)"/.exec(svg);
  if (!id) return svg;
  const name = id[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return svg.replace(new RegExp(`${name}(?![0-9])`, 'g'), `${id[1]}-zoom`);
}
