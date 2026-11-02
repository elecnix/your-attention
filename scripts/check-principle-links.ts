// Checks that every link to a heading of PRINCIPLES.md reaches a heading that exists, and that a link which shows a
// number shows the number of the heading it reaches. A principle is cited by its number, and its link carries the number
// too, so a renumbering that misses a link would leave a reference that goes nowhere, or one that names another
// principle. Run it with `npm run check:principles`: it prints one line per link that does not resolve, and exits with 1
// when it finds one. `test/unit/principles.test.ts` runs the same check.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Directories with no Markdown of this repository in them, and the files that hold a generated page. */
const SKIP = new Set(['.git', 'node_modules', '.cloudflare', 'storybook-static', 'coverage', 'dist', 'playwright-report', 'test-results']);

/**
 * The anchor that GitHub gives a heading: lowercase, punctuation dropped, spaces to hyphens, and consecutive hyphens
 * kept. So `DP20: Each card has one clear state` becomes `dp20-each-card-has-one-clear-state`, and an em dash between
 * two spaces would leave the two hyphens. GitHub writes the id with the `user-content-` prefix, and a link's fragment is
 * the same text without that prefix.
 */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

export type Heading = { readonly line: number; readonly title: string; readonly anchor: string };

/** Every `### ` heading of PRINCIPLES.md, in document order. */
export function principleHeadings(root: string = ROOT): Heading[] {
  const text = fs.readFileSync(path.join(root, 'PRINCIPLES.md'), 'utf8').replace(/\r\n/g, '\n');
  const headings: Heading[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.startsWith('### ')) return;
    const title = line.slice(4).trim();
    headings.push({ line: i + 1, title, anchor: slug(title) });
  });
  return headings;
}

export type Link = {
  readonly file: string;
  readonly line: number;
  readonly anchor: string;
  /** The visible text of a Markdown link, and the address when the file names one without link text. */
  readonly label: string;
  readonly text: string;
};

/** Reads a file as text, or returns null for a file that holds bytes rather than text. */
function readText(file: string): string | null {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8');
}

/** Every file of the repository that a text read can hold, in a stable order. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** A Markdown link to a heading of PRINCIPLES.md, or an address to one written without link text. */
const LINK = /\[([^\]]*)\]\(\s*PRINCIPLES\.md#([\w-]+)\s*\)|PRINCIPLES\.md#([\w-]+)/g;

/** Every link in the repository whose target is a heading of PRINCIPLES.md, in file order. */
export function principleLinks(root: string = ROOT): Link[] {
  const links: Link[] = [];
  for (const file of walk(root)) {
    const text = readText(file);
    if (text === null || !text.includes('PRINCIPLES.md#')) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    for (const match of text.matchAll(LINK)) {
      const anchor = match[2] ?? match[3]!;
      const line = text.slice(0, match.index).split('\n').length;
      links.push({ file: relative, line, anchor, label: match[1] ?? anchor, text: match[0] });
    }
  }
  return links;
}

export type Report = {
  readonly headings: Heading[];
  readonly links: Link[];
  /** Links whose anchor no heading has. */
  readonly broken: Link[];
  /** Links that show a number, and not the number of the heading they reach. */
  readonly mismatched: Link[];
};

/** The headings of PRINCIPLES.md, every link to one, the links that reach none, and the ones that name another number. */
export function check(root: string = ROOT): Report {
  const headings = principleHeadings(root);
  const links = principleLinks(root);
  const anchors = new Map(headings.map((h) => [h.anchor, h]));
  const number = (text: string): string | undefined => text.match(/\bDP(\d+)\b/)?.[1];
  return {
    headings,
    links,
    broken: links.filter((l) => !anchors.has(l.anchor)),
    mismatched: links.filter((l) => {
      const shown = number(l.label);
      return shown !== undefined && shown !== number(anchors.get(l.anchor)?.title ?? '');
    }),
  };
}

function main(): void {
  const root = process.argv[2] === undefined ? ROOT : path.resolve(process.argv[2]);
  const { headings, links, broken, mismatched } = check(root);
  console.log(`PRINCIPLES.md has ${headings.length} numbered headings.`);
  const files = new Set(links.map((l) => l.file)).size;
  console.log(`${links.length} links to a heading of PRINCIPLES.md, in ${files} file${files === 1 ? '' : 's'}.`);
  for (const l of broken) console.log(`${l.file}:${l.line}: ${l.text} reaches no heading`);
  for (const l of mismatched) console.log(`${l.file}:${l.line}: ${l.text} shows another number than the heading it reaches`);
  if (broken.length > 0 || mismatched.length > 0) {
    console.log(`${broken.length + mismatched.length} of ${links.length} links are wrong.`);
    process.exitCode = 1;
    return;
  }
  console.log('Every link reaches a heading, and shows that heading number.');
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
