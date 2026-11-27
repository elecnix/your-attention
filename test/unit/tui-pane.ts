// A terminal card view driven by keys, as the card pane tests use it.
import assert from 'node:assert/strict';
import { summarize } from '../../src/core/summary.ts';
import type { Card } from '../../src/core/types.ts';
import { CardView, type CardViewHost } from '../../src/tui/cardview.ts';
import type { KeyEvent } from '../../src/tui/input.ts';
import { makeTheme } from '../../src/tui/theme.ts';
import { buildQueue, type InboxState } from '../../web/queue.js';

export const theme = makeTheme({ color: 0, unicode: true, hyperlinks: false });

/** The text a card view draws, one line of the terminal per line. */
export const plain = (doc: { lines: { spans: { text: string }[] }[] }): string => doc.lines.map((l) => l.spans.map((x) => x.text).join('')).join('\n');

/** A view of `c` at `width` columns, with helpers that draw it again after each step. */
export function setup(c: Card, over: Partial<InboxState> = {}, width = 70) {
  const acts: unknown[] = [];
  const host: CardViewHost = { theme, address: (id) => `http://127.0.0.1:4815/#card=${id}`, act: (_v, a) => acts.push(a), fileText: () => undefined, now: () => 600_000 };
  const s: InboxState = { cards: [summarize(c, undefined)], answers: {}, presence: {}, states: { [c.id]: 'open' }, levels: [{ id: 'now', label: 'Decide now', definition: '', color: '#e5484d' }], ...over };
  const view = new CardView(c, host);
  const build = () => view.build(width, s, buildQueue(s, 'none'));
  build();
  const text = () => plain(build());
  /** Focus the stop whose id starts with `prefix`. */
  const focus = (prefix: string) => { build(); const id = view.stops().find((x) => x.startsWith(prefix)); assert.ok(id, `no stop ${prefix} in ${view.stops().join(', ')}`); view.focus = id; build(); };
  const key = (name: string, mods: Partial<KeyEvent> = {}) => { const ok = view.key({ type: 'key', name, ctrl: false, alt: false, shift: false, ...mods }); build(); return ok; };
  const type = (t: string) => { for (const ch of t) key(ch, { text: ch }); };
  return { view, acts, build, text, focus, key, type };
}
