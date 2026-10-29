// A card body is OpenUI Lang, and the page draws what the OpenUI parser reads of it. Both builds use this check. The parser drops a statement it
// cannot read, and everything after a string that never closes, without an error. So the inbox reads each body with the
// same parser and the page's component list, and refuses one the page would draw only in part.
import { createParser, type Parser } from '@openuidev/lang-core';
import { LIBRARY } from './openui-library.ts';

let parser: Parser | undefined;

/** What keeps the page from drawing all of a body, one sentence each. Empty when the page draws it whole. */
export function bodyErrors(body: string): string[] {
  parser ??= createParser(LIBRARY as Parameters<typeof createParser>[0], 'root');
  const { root, meta } = parser.parse(body);
  const starts = statementStarts(body);
  if (!starts.some((s) => s.name === 'root')) return ['the body has no `root = ...` statement. Put Markdown in text, and OpenUI Lang in body.'];
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

/** Each line that starts a statement, in order, as the parser counts them. A line inside a string belongs to the statement before it. */
function statementStarts(body: string): { name: string; line: number }[] {
  const starts: { name: string; line: number }[] = [];
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
      if (m) starts.push({ name: m[1]!, line });
    }
  }
  return starts;
}
