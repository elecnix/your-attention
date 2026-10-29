// Widgets are saved parts of a card body, in OpenUI Lang, such as a pull request.
// A body or a template places one with a line of its own:
//
//   pr = widget pull-request {"title": "Add stop", "repo": "your-attention", "ci": "green"}
//
// The inbox replaces that line with the widget's statements, filled from the JSON
// the way a template is. The widget's root takes the placed name, and its other
// names get the placed name as a prefix, so one widget can appear twice in a card.
import { InboxError } from './inbox.ts';

export interface WidgetSource {
  name: string;
  version: number;
  source: string;
  /** Text for the agent, filled from the person's answer. */
  response?: string;
}

/** A placed widget's response, with the values the card placed it with. */
export interface PlacedResponse {
  widget: string;
  version: number;
  template: string;
  values: Record<string, unknown>;
}

/** Whether an answer value counts as yes: true, text, a list or a check box group with an item on. */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.values(v).some(truthy);
  return typeof v === 'string' ? v.trim() !== '' : Boolean(v);
}

/** Fill a response from the answer, and where the answer has no value, from the values the card placed the widget with.
 * {{name}} is the value as text, {{#name}}...{{/name}} shows when the value counts as yes, and {{^name}}...{{/name}} when it does not. */
export function respond(template: string, answer: Record<string, unknown>, placed: Record<string, unknown>): string {
  const value = (k: string): unknown => (k in answer && answer[k] !== undefined && answer[k] !== '' ? answer[k] : placed[k]);
  const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : Object.keys(v).filter((x) => truthy((v as Record<string, unknown>)[x])).join(', ')) : String(v));
  const sections = template.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, kind: string, k: string, inner: string) => (truthy(value(k)) === (kind === '#') ? inner : ''));
  return sections.replace(/\{\{(\w+)\}\}/g, (_, k: string) => text(value(k))).trim();
}

const PLACE = /^(\s*)([A-Za-z_]\w*)\s*=\s*widget\s+([\w.-]+)(?:@(\d+))?\s*(.*)$/;
const STRING = /("(?:[^"\\]|\\.)*")/;
const MAX_DEPTH = 8;
// Depth alone does not bound the work: eight widgets that each place the next fifty times would expand 50^7 times.
const MAX_PLACEMENTS = 100;

/** Each widget and version once, in the order the card first placed it. */
export function distinctWidgets(list: { name: string; version: number }[]): { name: string; version: number }[] {
  const seen = new Set<string>();
  return list.filter((w) => !seen.has(`${w.name}@${w.version}`) && Boolean(seen.add(`${w.name}@${w.version}`)));
}

/** Fill a source's {{name}} placeholders, each with the JSON string of its value. */
export function fill(source: string, vars: Record<string, unknown>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (_, k: string) => JSON.stringify(String(vars[k] ?? '')));
}

/** Rename the names a widget defines, outside string literals. */
function rename(source: string, placed: string): string {
  const defined = new Set([...source.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]!));
  const to = (n: string) => (n === 'root' ? placed : `${placed}_${n}`);
  return source.split(STRING).map((part, i) => (i % 2 ? part : part.replace(/(?<![@\w])[A-Za-z_]\w*/g, (n) => (defined.has(n) ? to(n) : n)))).join('');
}

export function expandWidgets(body: string, find: (name: string, version?: number) => WidgetSource, stack: string[] = [], budget = { left: MAX_PLACEMENTS }): { body: string; used: { name: string; version: number }[]; responses: PlacedResponse[] } {
  const used: { name: string; version: number }[] = [];
  const responses: PlacedResponse[] = [];
  const lines = body.split('\n').map((line) => {
    const m = PLACE.exec(line);
    if (!m) return line;
    const [, indent, placed, name, version, json] = m as unknown as [string, string, string, string, string | undefined, string];
    if (stack.includes(name)) throw new InboxError(400, `widget ${name} places itself`);
    if (stack.length >= MAX_DEPTH) throw new InboxError(400, `widgets nest at most ${MAX_DEPTH} deep`);
    if (--budget.left < 0) throw new InboxError(400, `a card places at most ${MAX_PLACEMENTS} widgets, counting the widgets inside widgets`);
    let vars: unknown = {};
    if (json.trim()) {
      try { vars = JSON.parse(json); } catch { vars = null; }
    }
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new InboxError(400, `widget ${name}: the values after its name must be a JSON object`);
    const w = find(name, version === undefined ? undefined : Number(version));
    const inner = expandWidgets(fill(w.source, vars as Record<string, unknown>), find, [...stack, name], budget);
    used.push({ name: w.name, version: w.version }, ...inner.used);
    if (w.response) responses.push({ widget: w.name, version: w.version, template: w.response, values: vars as Record<string, unknown> });
    responses.push(...inner.responses);
    return rename(inner.body.trim(), placed).split('\n').map((l) => indent + l.trimStart()).join('\n');
  });
  return { body: lines.join('\n'), used, responses };
}
