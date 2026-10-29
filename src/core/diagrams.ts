// Mermaid diagrams on a card: a ```mermaid block in its text or recommendation, or a
// Mermaid("...") statement in its body. The inbox checks each one with the platform's
// checker before it takes the card, so the person never sees a diagram the page cannot draw.
import { InboxError } from './inbox.ts';

/** Resolves to mermaid's error for a diagram it cannot draw, or to undefined when it can. */
export interface DiagramCheck {
  (source: string): Promise<string | undefined>;
  /** The mermaid version that checks, which is the one the page draws with. */
  version: string;
}

export interface Diagram {
  /** Where the card shows it, for the error the agent reads. */
  where: string;
  source: string;
}

/** The errors of the diagrams a card shows, by source. */
export type CheckedDiagrams = Map<string, string | undefined>;

export const MAX_DIAGRAMS = 20;
/** A fence line that opens a Mermaid block. web/markdown.js draws the same blocks. */
export const MERMAID_FENCE = /^```\s*mermaid(\s|$)/i;

function markdownDiagrams(field: string, src: string | undefined): Diagram[] {
  if (!src) return [];
  // The page's Markdown reader opens a fence at any line that starts with ``` and closes it at the next one.
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const found: Diagram[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^```/.test(lines[i]!)) continue;
    const start = i;
    const code: string[] = [];
    for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
    if (MERMAID_FENCE.test(lines[start]!)) found.push({ where: `${field}, the diagram on line ${start + 1}`, source: code.join('\n') });
  }
  return found;
}

// The page draws a body with OpenUI, so the inbox reads the body as @openuidev/browser-bundle 0.2.1 does:
// it takes the code out of ``` fences when the body has them, drops // and # comments, then reads tokens.
// Each function below follows the bundle function its comment names. A Mermaid call they miss draws as its source.

/** The end of a double-quoted string that starts at i, or i. (bQ) */
function quoted(e: string, i: number): number {
  if (e[i] !== '"') return i;
  let r = i + 1;
  while (r < e.length) {
    if (e[r] === '\\') r += 2;
    else if (e[r] === '"') return r + 1;
    else r++;
  }
  return r;
}

/** The code inside ``` fences, or the body when it has none. (qHt) */
function unfence(e: string): string {
  const fence = (i: number) => e[i] === '`' && e[i + 1] === '`' && e[i + 2] === '`';
  const blocks: string[] = [];
  let r = 0;
  while (r < e.length) {
    let open = -1;
    while (r < e.length) {
      const q = quoted(e, r);
      if (q > r) { r = q; continue; }
      if (fence(r)) { open = r; break; }
      r++;
    }
    if (open === -1) break;
    let n = open + 3;
    while (n < e.length && e[n] !== '\n') n++;
    if (n >= e.length) { blocks.push(e.slice(open + 3).replace(/^[^\n]*\n?/, '')); break; }
    n++;
    let close = -1;
    let i = n;
    while (i < e.length) {
      const q = quoted(e, i);
      if (q > i) { i = q; continue; }
      if (fence(i)) { close = i; break; }
      i++;
    }
    if (close !== -1) { blocks.push(e.slice(n, close)); r = close + 3; } else { blocks.push(e.slice(n)); r = e.length; }
  }
  if (blocks.length) return blocks.join('\n');
  if (!e.startsWith('```')) return e;
  let a = 3;
  while (a < e.length && e[a] !== '\n') a++;
  const rest = e.slice(a < e.length ? a + 1 : 3);
  const last = rest.lastIndexOf('```');
  return last !== -1 ? rest.slice(0, last) : rest;
}

/** The body without // and # comments, which end at the line's end outside a string. (VHt) */
function uncomment(e: string): string {
  let inside: string | false = false;
  return e.split('\n').map((line) => {
    for (let a = 0; a < line.length; a++) {
      const c = line[a];
      if (inside) {
        if (c === '\\' && a + 1 < line.length) { a++; continue; }
        if (c === inside) inside = false;
        continue;
      }
      if (c === '"' || c === "'") { inside = c; continue; }
      if ((c === '/' && line[a + 1] === '/') || c === '#') return line.slice(0, a).trimEnd();
    }
    return line;
  }).join('\n');
}

type Token = { t: 'nl' | '(' | ')' | ',' | '=' | 'other' } | { t: 'str' | 'name'; v: string };

/** The tokens the statements read: strings with OpenUI's escapes, names, and the punctuation around calls. (pQ) */
function tokens(e: string): Token[] {
  const out: Token[] = [];
  const word = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
  let r = 0;
  while (r < e.length) {
    const c = e[r]!;
    if (c === ' ' || c === '\t' || c === '\r') { r++; continue; }
    if (c === '\n') { out.push({ t: 'nl' }); r++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c }); r++; continue; }
    if (c === '=') {
      if (e[r + 1] === '=') { out.push({ t: 'other' }); r += 2; } else { out.push({ t: '=' }); r++; }
      continue;
    }
    if (c === '"') {
      // A string JSON cannot read keeps its text as written, and one with no closing quote gets one.
      const at = r;
      let closed = false;
      for (r++; r < e.length;) {
        if (e[r] === '\\') r += 2;
        else if (e[r] === '"') { r++; closed = true; break; } else r++;
      }
      const raw = e.slice(at, r);
      let v: string;
      try { v = String(JSON.parse(closed ? raw : `${raw}"`)); } catch { v = raw.replace(/^"|"$/g, ''); }
      out.push({ t: 'str', v });
      continue;
    }
    if (c === "'") {
      let v = '';
      for (r++; r < e.length;) {
        if (e[r] === '\\') {
          r++;
          if (r < e.length) { const x = e[r]!; v += x === 'n' ? '\n' : x === 't' ? '\t' : x; r++; }
        } else if (e[r] === "'") { r++; break; } else v += e[r++];
      }
      out.push({ t: 'str', v });
      continue;
    }
    if ((c === '$' || c === '@') && /[A-Za-z_]/.test(e[r + 1] ?? '')) {
      for (r++; word(e[r]); r++);
      out.push({ t: 'other' });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const at = r;
      for (; word(e[r]); r++);
      out.push({ t: 'name', v: e.slice(at, r) });
      continue;
    }
    out.push({ t: 'other' });
    r++;
  }
  return out;
}

function bodyDiagrams(body: string | undefined): Diagram[] {
  if (!body) return [];
  const list = tokens(uncomment(unfence(String(body).trim())).trim());
  const found: Diagram[] = [];
  let statement: string | undefined;
  let depth = 0;
  for (let i = 0; i < list.length; i++) {
    const k = list[i]!;
    const at = (j: number) => list[j]?.t;
    if (k.t === '(') depth++;
    else if (k.t === ')') depth = Math.max(0, depth - 1);
    // A statement starts a line with its name and =, outside any open call.
    if (depth === 0 && k.t === 'name' && (i === 0 || at(i - 1) === 'nl') && at(i + 1) === '=') statement = k.v;
    if (k.t !== 'name' || k.v !== 'Mermaid' || at(i + 1) !== '(') continue;
    const where = statement ? `body, statement ${statement}` : `body, diagram ${found.length + 1}`;
    const arg = list[i + 2];
    if (arg?.t !== 'str' || (at(i + 3) !== ')' && at(i + 3) !== ',')) throw new InboxError(400, `${where}: Mermaid takes the diagram source as a string, such as Mermaid("flowchart TD\\n  A --> B")`);
    found.push({ where, source: arg.v });
  }
  return found;
}

/** Every diagram the page draws for these fields, in the order the card shows them. */
export function findDiagrams(fields: { text?: string | undefined; recommendation?: string | undefined; body?: string | undefined }): Diagram[] {
  return [...markdownDiagrams('text', fields.text), ...markdownDiagrams('recommendation', fields.recommendation), ...bodyDiagrams(fields.body)];
}

/** Check each diagram once, and reject the card with mermaid's own words for each one it cannot draw. */
export async function checkDiagrams(found: Diagram[], check: DiagramCheck | undefined): Promise<CheckedDiagrams> {
  const checked: CheckedDiagrams = new Map();
  if (!found.length) return checked;
  if (!check) throw new InboxError(400, 'this inbox cannot check Mermaid diagrams, so it takes no card with one');
  if (found.length > MAX_DIAGRAMS) throw new InboxError(400, `a card shows at most ${MAX_DIAGRAMS} diagrams`);
  for (const d of found) if (!checked.has(d.source)) checked.set(d.source, await check(d.source));
  const bad = found.filter((d) => checked.get(d.source) !== undefined);
  if (bad.length) {
    throw new InboxError(400, bad.map((d) => `The Mermaid diagram in ${d.where} does not parse, so the inbox did not take the card. Mermaid ${check.version} says:\n${checked.get(d.source)}`).join('\n\n'));
  }
  return checked;
}

/** The card commits with no await after its check, so a diagram missing from the check means the card changed meanwhile. */
export function requireChecked(found: Diagram[], checked: CheckedDiagrams | undefined): void {
  for (const d of found) {
    if (!checked?.has(d.source)) throw new InboxError(409, `${d.where}: the inbox did not check this diagram before the card changed. Post the card again`);
    if (checked.get(d.source) !== undefined) throw new InboxError(400, `${d.where}: mermaid cannot parse this diagram`);
  }
}
