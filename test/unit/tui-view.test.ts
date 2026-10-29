// The frame: what the terminal can show, the panes at each width, the list's sections and symbols, and the click targets.
import { summarize } from '../../src/core/summary.ts';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { buildQueue, type InboxState } from '../../web/queue.js';
import type { Card } from '../../src/core/types.ts';
import { loadParser } from '../../src/tui/body.ts';
import { CardView } from '../../src/tui/cardview.ts';
import type { Caps } from '../../src/tui/screen.ts';
import { detectCaps, makeTheme } from '../../src/tui/theme.ts';
import { drawFrame, listWidth, type Model } from '../../src/tui/view.ts';

const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, agent: `a-${id}`, kind: 'ask', title: `Card ${id}`, priority: 'now', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [], ...extra });

function model(width: number, height: number, caps: Caps = { color: 3, unicode: true, hyperlinks: true }): Model {
  const cards = [card('a'), card('b', { priority: 'later' }), card('c'), card('d', { replies: [{ text: 'more', at: 5, seenAt: null }] })];
  const answer = { card: 'c', version: 1, values: {}, comment: '', delivery: 'default' as const, savedAt: 3, deliveredAt: 4, readAt: null, forcedAt: null, previous: [] };
  // The state has the summaries, and the card on screen is whole.
  const state: InboxState = {
    cards: cards.map((c) => summarize(c, c.id === 'c' ? answer : undefined)),
    answers: { c: { version: 1, savedAt: 3, deliveredAt: 4, readAt: null, forcedAt: null } },
    presence: {},
    states: { a: 'open', b: 'open', c: 'delivered', d: 'open' },
    levels: [{ id: 'now', label: 'Decide now', definition: '', color: '#e5484d' }, { id: 'later', label: 'Can wait', definition: '' }],
  };
  const theme = makeTheme(caps);
  const queue = buildQueue(state, 'none');
  const current = queue.byId['a']!;
  const view = new CardView(cards[0]!, { theme, address: (id) => `http://x/#card=${id}`, act: () => {}, fileText: () => undefined, now: () => 10 });
  return { theme, width, height, state, queue, current, view, zone: 'list', listScroll: 0, cardScroll: 0, groupBy: 'none', fresh: new Set(['b']), connected: true, help: false, cleared: false, now: 10 };
}

before(async () => { await loadParser(); });

describe('terminal capabilities', () => {
  it('turns color off for NO_COLOR, --mono and a dumb terminal, and picks the depth the terminal reports', () => {
    assert.equal(detectCaps({ NO_COLOR: '1', COLORTERM: 'truecolor' }).color, 0);
    assert.equal(detectCaps({ NO_COLOR: '' , TERM: 'xterm-256color' }).color, 2);
    assert.equal(detectCaps({ TERM: 'xterm-256color' }, { mono: true }).color, 0);
    assert.equal(detectCaps({ TERM: 'dumb' }).color, 0);
    assert.equal(detectCaps({ COLORTERM: 'truecolor' }).color, 3);
    assert.equal(detectCaps({ TERM_PROGRAM: 'ghostty' }).color, 3);
    assert.equal(detectCaps({ TERM: 'xterm' }).color, 1);
    assert.equal(detectCaps({ TERM: 'tmux-256color', YOUR_ATTENTION_TUI_COLOR: 'truecolor' }).color, 3);
  });

  it('uses Unicode with a UTF-8 locale, ASCII on the Linux console or when asked, and no hyperlinks in Apple Terminal', () => {
    assert.equal(detectCaps({ LANG: 'en_US.UTF-8' }).unicode, true);
    assert.equal(detectCaps({ LANG: 'C' }).unicode, false);
    assert.equal(detectCaps({ LANG: 'en_US.UTF-8', TERM: 'linux' }).unicode, false);
    assert.equal(detectCaps({ LANG: 'en_US.UTF-8' }, { ascii: true }).unicode, false);
    assert.equal(detectCaps({ TERM_PROGRAM: 'Apple_Terminal' }).hyperlinks, false);
    assert.equal(detectCaps({ TERM_PROGRAM: 'iTerm.app' }).hyperlinks, true);
  });
});

describe('the frame', () => {
  it('puts the list beside the card from 60 columns, and one pane at a time below', () => {
    assert.equal(listWidth(50), 0);
    assert.equal(listWidth(80), 30);
    assert.equal(listWidth(100), 34);
    const f = drawFrame(model(80, 24));
    assert.match(f.grid.row(0), /Your attention .* Inbox connected .* 3 waiting/);
    assert.equal(f.grid.chars[2 * 80 + 30], '│');
    const narrow = drawFrame(model(50, 24));
    assert.doesNotMatch(narrow.grid.row(3), /│/);
  });

  it('lists each section with a count, each card with a symbol and its level in words, and marks the open card', () => {
    const f = drawFrame(model(100, 30));
    const rows = Array.from({ length: 30 }, (_, y) => f.grid.row(y).slice(0, 34).trimEnd());
    assert.ok(rows.includes('Agent replied (1)'), rows.join('\n'));
    assert.ok(rows.includes('Waiting for you (2)'));
    assert.ok(rows.some((r) => r.startsWith('Outbox: not read by the agent')));
    assert.ok(rows.some((r) => r === '  ↩ now   Card d'));
    assert.ok(rows.some((r) => r === '▶ ◉ now   Card a'));
    assert.ok(rows.some((r) => r === '  ● later Card b new'));
    assert.ok(rows.some((r) => r === '  ◑ Card c'));
    assert.deepEqual(f.listCards, ['d', 'a', 'b', 'c']);
    const hit = f.hits.find((h) => h.target === 'list:b');
    assert.ok(hit && f.grid.row(hit.y).includes('Card b'));
  });

  it('keeps every symbol and label in ASCII, and the open card in inverse video without color', () => {
    const m = model(100, 30, { color: 0, unicode: false, hyperlinks: false });
    const f = drawFrame(m);
    const y = Array.from({ length: 30 }, (_, i) => i).find((i) => f.grid.row(i).startsWith('> @ now   Card a'));
    assert.ok(y !== undefined, Array.from({ length: 30 }, (_, i) => f.grid.row(i)).join('\n'));
    for (let i = 0; i < 30; i++) assert.match(f.grid.row(i), /^[\x20-\x7e]*$/);
  });

  it('scrolls the list to the open card after another card opens, however far down it is', () => {
    const m = model(100, 20);
    const cards = Array.from({ length: 80 }, (_, i) => card(`k${i}`));
    m.state = { ...m.state!, cards: cards.map((c) => summarize(c, undefined)), states: Object.fromEntries(cards.map((c) => [c.id, 'open'])) };
    m.queue = buildQueue(m.state, 'none');
    m.current = m.queue.byId['k70']!;
    m.revealList = true;
    const f = drawFrame(m);
    assert.ok(Array.from({ length: 20 }, (_, y) => f.grid.row(y)).some((r) => r.startsWith('▶ ◉ now   Card k70')));
    assert.ok(m.listScroll > 0);
  });
});
