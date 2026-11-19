/** A width and a height, in pixels. */
export interface Size { width: number; height: number }
/** The width and height of a mermaid SVG, from its viewBox, or null when it has none to read. */
export function naturalSize(svg: string): Size | null;
/** The size a diagram of `natural` size opens at on a `screen`: as large as the screen fits, never below its own size. */
export function zoomSize(natural: Size, screen: Size): Size;
/** The SVG with its id, and every reference to it, renamed for the full-screen copy. */
export function zoomedSvg(svg: string): string;
