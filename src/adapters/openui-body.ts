// A card body is OpenUI Lang, and the page draws what the OpenUI parser reads of it. Both builds use this check. The parser drops a statement it
// cannot read, and everything after a string that never closes, without an error. So the inbox reads each body with the
// same parser and the page's component list, and refuses one the page would draw only in part.
import { createParser, type Parser } from '@openuidev/lang-core';
import { LIBRARY } from './openui-library.ts';

let parser: Parser | undefined;
const read = (body: string) => (parser ??= createParser(LIBRARY as Parameters<typeof createParser>[0], 'root')).parse(body);

/** What keeps the page from drawing all of a body, one sentence each. Empty when the page draws it whole. */
export function bodyErrors(body: string): string[] {
  const { root, meta } = read(body);
  const starts = statementStarts(body);
  // Any line that reads as a root statement counts, even one an unclosed string hides, so that error names the string.
  if (!/^[ \t]*root[ \t]*=/m.test(body)) return ['the body has no `root = ...` statement. Put Markdown in text, and OpenUI Lang in body.'];
  const errors: string[] = [];
  if (meta.incomplete) {
    const last = starts[meta.statementCount - 1];
    const where = last ? `\`${last.name}\` (line ${last.line})` : 'the last statement';
    errors.push(`${where} has a string that never closes, so the page drops it and every statement after it. Open and close each string with a plain ", and write \\" only for a quote inside a string.`);
  }
  for (const name of meta.unresolved) errors.push(`\`${name}\` is used but never defined.`);
  for (const e of meta.errors) errors.push(`\`${e.statementId ?? 'root'}\`: ${e.message}.`);
  if (!root && !errors.length) errors.push('the page draws nothing from this body.');
  return errors;
}

/** What the page draws for a body it can't draw whole, which an inbox stored before it checked bodies. */
export interface BodyFallback {
  /** OpenUI Lang: the statements before the first broken one as the agent wrote them, then the source from it on. */
  body: string;
  /** What keeps the page from drawing the agent's body whole, as bodyErrors lists it. */
  faults: string[];
}

const fallbacks = new Map<string, BodyFallback | undefined>();

/** The fallback for a body the page can't draw whole, or undefined for one it draws whole. */
export function fallbackBody(body: string): BodyFallback | undefined {
  if (fallbacks.has(body)) return fallbacks.get(body);
  const faults = bodyErrors(body);
  let out: BodyFallback | undefined;
  if (faults.length) {
    const { meta } = read(body);
    const starts = statementStarts(body);
    // An unclosed string hides every statement from its own on. Before it, a statement with a broken call draws nothing.
    const cut = meta.incomplete ? (starts[meta.statementCount - 1]?.at ?? 0) : body.length;
    const failed = new Set(meta.errors.map((e) => e.statementId).filter((id): id is string => !!id && id !== 'root'));
    const segments = starts.filter((st) => st.at < cut).map((st, i, all) => ({ ...st, text: body.slice(st.at, all[i + 1]?.at ?? cut).replace(/\n+$/, '') }));
    const kept = segments.filter((st) => !failed.has(st.name));
    const shown = [...segments.filter((st) => failed.has(st.name)).map((st) => st.text), body.slice(cut).replace(/\n+$/, '')].filter(Boolean).join('\n');
    const source = (text: string) => `yaSource = CodeBlock("text", ${JSON.stringify(text)})`;
    const whole = `root = Card([yaSource])\n${source(body)}`;
    // The root keeps the children the kept statements define, then the source, after what did draw.
    const defined = new Set(kept.map((st) => st.name));
    let joined = false;
    const lines = kept.map((st) => st.name !== 'root' ? st.text : st.text.replace(/^([ \t]*root[ \t]*=[ \t]*Card\(\[)([^\]\n]*)\]/, (_, open: string, kids: string) => {
      joined = true;
      return `${open}${[...kids.split(',').map((k) => k.trim()).filter((k) => defined.has(k)), 'yaSource'].join(', ')}]`;
    }));
    const partial = `${lines.join('\n')}\n${source(shown || faults.join('\n'))}`;
    out = { body: joined && !bodyErrors(partial).length ? partial : whole, faults };
  }
  if (fallbacks.size > 500) fallbacks.clear();
  fallbacks.set(body, out);
  return out;
}

/** Each line that starts a statement, in order, as the parser counts them. A line inside a string belongs to the statement before it. */
function statementStarts(body: string): { name: string; line: number; at: number }[] {
  const starts: { name: string; line: number; at: number }[] = [];
  let quote = '';
  let line = 1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '\n') line++;
    if (quote) {
      if (c === '\\') { if (body[i + 1] === '\n') line++; i++; } else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (i === 0 || body[i - 1] === '\n') {
      const m = /^[ \t]*([A-Za-z_]\w*)[ \t]*=/.exec(body.slice(i, i + 200));
      if (m) starts.push({ name: m[1]!, line, at: i });
    }
  }
  return starts;
}
