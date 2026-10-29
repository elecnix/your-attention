/** A function that builds one element, as React.createElement does. */
export type Hyperscript<T> = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => T;
export interface MarkdownOptions<T> {
  /** What a [[card-id]] link becomes. */
  cardLink?: (id: string, key: string) => T | string;
  /** Keep a line break inside a paragraph. */
  breaks?: boolean;
}
export const SESSION_LINK: RegExp;
export function renderInline<T>(h: Hyperscript<T>, text: string | undefined, opts?: MarkdownOptions<T>): (T | string)[];
export function renderMarkdown<T>(h: Hyperscript<T>, src: string, opts?: MarkdownOptions<T>): T[];
