// A card body is OpenUI Lang, and the page draws what the OpenUI parser reads of it. The laptop inbox and the posting client
// use this check. The parser drops a statement it cannot read, and everything after a string that never closes, without an
// error. So the inbox reads each body with the same parser and the page's component list, and refuses one the page would
// draw only in part. web/body-faults.js reads the parser's result, so the page finds the same faults on an inbox that does not check.
import { createParser, type Parser } from '@openuidev/lang-core';
import { bodyFaults, fallbackSources, type Parsed } from '../../web/body-faults.js';
import { LIBRARY } from './openui-library.ts';

let parser: Parser | undefined;
const read = (body: string): Parsed => (parser ??= createParser(LIBRARY as Parameters<typeof createParser>[0], 'root')).parse(body) as Parsed;

/** What keeps the page from drawing all of a body, one sentence each. Empty when the page draws it whole. */
export function bodyErrors(body: string): string[] {
  return bodyFaults(body, read(body));
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
  const parsed = read(body);
  const faults = bodyFaults(body, parsed);
  let out: BodyFallback | undefined;
  if (faults.length) {
    const { partial, whole } = fallbackSources(body, parsed);
    out = { body: partial !== undefined && !bodyErrors(partial).length ? partial : whole, faults };
  }
  if (fallbacks.size > 500) fallbacks.clear();
  fallbacks.set(body, out);
  return out;
}
