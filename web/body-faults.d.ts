/** What the OpenUI parser reads of a body: what @openuidev/lang-core's parse returns, and the page's Renderer reports. */
export interface Parsed {
  root: unknown;
  meta: { incomplete: boolean; statementCount: number; unresolved: string[]; errors: { statementId?: string; message: string }[] };
}
export function bodyFaults(body: string, parsed: Parsed): string[];
export function fallbackSources(body: string, parsed: Parsed): { partial: string | undefined; whole: string };
