// Checks a Mermaid diagram with mermaid's own parser, the version the page draws with.
// Both builds use it: the laptop inbox in Node, and the hosted inbox in its Durable Object.
// It loads mermaid on the first diagram, so an inbox that never sees one never pays for it.
import type { DiagramCheck } from '../core/diagrams.ts';

/** Pinned exactly in package.json. web/components.js loads the same version. */
export const MERMAID_VERSION = '11.17.2';
/** The settings the page draws with. The theme changes only colors, so the check leaves it out. */
export const MERMAID_CONFIG = { startOnLoad: false, securityLevel: 'strict' } as const;

type Mermaid = (typeof import('mermaid'))['default'];
let loading: Promise<Mermaid> | undefined;
// mermaid keeps the diagram it parses in module state, so one parse runs at a time.
let queue: Promise<unknown> = Promise.resolve();
// A patch checks the card's other diagrams again, so recent results are kept.
const recent = new Map<string, string | undefined>();
const RECENT = 200;

async function load(): Promise<Mermaid> {
  // Without a DOM, DOMPurify has neither sanitize nor addHook, and mermaid's parser calls both on labels.
  // A DOMPurify that finds no usable DOM returns the text it gets, and these do the same. They change no global.
  const { default: DOMPurify } = await import('dompurify');
  if (!DOMPurify.isSupported) Object.assign(DOMPurify, { sanitize: (dirty: string) => dirty, addHook: () => {} });
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize(MERMAID_CONFIG);
  return mermaid;
}

async function parse(source: string): Promise<string | undefined> {
  const mermaid = await (loading ??= load());
  // The page refuses to draw a diagram over maxTextSize, and the parser does not check it.
  const max = mermaid.mermaidAPI.getConfig().maxTextSize ?? 50_000;
  if (source.length > max) return `A diagram takes at most ${max} characters, and this one has ${source.length}.`;
  try {
    await mermaid.parse(source);
    return undefined;
  } catch (e) {
    return String((e as Error)?.message ?? e).trim();
  }
}

export const checkMermaid: DiagramCheck = Object.assign(async (source: string): Promise<string | undefined> => {
  if (recent.has(source)) return recent.get(source);
  const next = queue.then(() => parse(source));
  queue = next.catch(() => undefined);
  const result = await next;
  recent.set(source, result);
  if (recent.size > RECENT) recent.delete(recent.keys().next().value as string);
  return result;
}, { version: MERMAID_VERSION });
