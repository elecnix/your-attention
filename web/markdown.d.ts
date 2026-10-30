/** A function that builds one element, as React.createElement does. */
export type Hyperscript<T> = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => T;
export interface MarkdownOptions<T> {
  /** What a [[card-id]] link becomes. */
  cardLink?: (id: string, key: string) => T | string;
  /** What a file: link on this machine becomes, from its decoded path and its label. Without it, the path as code. */
  fileLink?: (path: string, label: string, key: string) => T | string;
  /** Keep a line break inside a paragraph. */
  breaks?: boolean;
  /** What a ```mermaid block becomes, from its source. */
  diagram?: (source: string, key: string) => T;
}
export const SESSION_LINK: RegExp;
export const MERMAID_FENCE: RegExp;
export function renderInline<T>(h: Hyperscript<T>, text: string | undefined, opts?: MarkdownOptions<T>): (T | string)[];
export function renderMarkdown<T>(h: Hyperscript<T>, src: string, opts?: MarkdownOptions<T>): T[];
