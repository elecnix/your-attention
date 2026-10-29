// One frame of the terminal client: the bar at the top, the card list on the left, the open card on the right, and
// the keys at the bottom. A pane under 60 columns shows the list or the card, one at a time.
import type { InboxState, Queue } from '../../web/queue.js';
import type { Card } from '../core/types.ts';
import type { CardView } from './cardview.ts';
import { drawLines, type Hit } from './doc.ts';
import { Grid, type Style } from './screen.ts';
import { clip, pad, sanitize, textWidth } from './text.ts';
import type { Theme } from './theme.ts';

export interface Model {
  theme: Theme;
  width: number;
  height: number;
  state: InboxState | null;
  queue: Queue | null;
  current: Card | null;
  view: CardView | null;
  zone: 'list' | 'card';
  listScroll: number;
  cardScroll: number;
  groupBy: string;
  fresh: Set<string>;
  connected: boolean;
  /** No answer from the inbox yet. */
  connecting?: boolean;
  /** A message in place of the inbox, such as while it loads, or why it cannot. */
  blank?: string;
  status?: { text: string; kind: 'info' | 'ok' | 'warn' };
  help: boolean;
  confirm?: string;
  pin?: { typed: number; message?: string };
  cleared: boolean;
  now: number;
  /** Scroll the card so its focused stop shows, after the focus moved. */
  reveal?: boolean;
  /** Scroll the list so the open card shows, after another card opened. */
  revealList?: boolean;
}

export interface Frame {
  grid: Grid;
  hits: Hit[];
  /** The rows of the list that hold cards, in order, for the arrow keys. */
  listCards: string[];
  listHeight: number;
  cardHeight: number;
  cardLines: number;
  /** The pane rectangles, for the mouse wheel. */
  listBox: { x: number; w: number };
  cardBox: { x: number; w: number };
}

/** The width of the list pane, or 0 when the screen shows one pane at a time. */
export function listWidth(width: number): number {
  if (width < 60) return 0;
  if (width >= 120) return 38;
  if (width >= 100) return 34;
  return 30;
}

/** Text cut to a width, with the theme's ellipsis: … or three dots. */
const cut = (m: Model, s: string, w: number): string => clip(s, w, m.theme.g.ellipsis);

interface Row { spans: { text: string; style?: Style }[]; target?: string; card?: string; selected?: boolean; dim?: boolean }

/** The rows of the card list: each section's header, its cards, and the actions at the end. */
export function listRows(m: Model, width: number): Row[] {
  const q = m.queue;
  const s = m.state;
  if (!q || !s) return [];
  const { s: st, g } = m.theme;
  const rows: Row[] = [];
  const groupLabel = m.groupBy === 'none' ? 'nothing' : m.groupBy.startsWith('tag:') ? m.groupBy.slice(4) : m.groupBy;
  rows.push({ spans: [{ text: 'Group by ', style: st.dim }, { text: groupLabel, style: st.link }, { text: '  (g)', style: st.dim }], target: 'list:group' });
  const section = (title: string, cards: Card[], empty: string, sent: boolean) => {
    rows.push({ spans: [] });
    rows.push({ spans: [{ text: cut(m, `${title}${cards.length ? ` (${cards.length})` : ''}`, width), style: st.header }] });
    rows.push({ spans: [{ text: g.rule.repeat(width), style: st.dim }] });
    if (!cards.length && empty) rows.push({ spans: [{ text: `  ${empty}`, style: st.dim }] });
    for (const c of cards) rows.push(cardRow(m, c, width, sent));
  };
  const replied = q.replied;
  const waitingGroups = q.groups;
  if (replied.length) section('Agent replied', replied, '', false);
  if (waitingGroups.length) for (const [title, cards] of waitingGroups) section(title, cards, 'Nothing waiting', false);
  else section('Waiting for you', [], 'Nothing waiting', false);
  if (q.checking.length) section('Being checked by triage', q.checking, '', false);
  section('Outbox: not read by the agent yet', q.outbox, 'Empty', true);
  section('Sent, newest first', q.sent, 'Nothing sent yet', true);
  if (q.dealt.length) {
    rows.push({ spans: [] });
    rows.push({ spans: [{ text: `Clear answered or closed: ${q.dealt.length}`, style: st.link }, { text: ' (C)', style: st.dim }], target: 'list:clear' });
  }
  return rows;
}

function cardRow(m: Model, c: Card, width: number, sent: boolean): Row {
  const q = m.queue!;
  const { s: st, g } = m.theme;
  const state = q.st(c);
  const selected = m.current?.id === c.id;
  const waiting = q.waiting(state) && state !== 'reply';
  // Each state has a symbol of its own shape, so the list reads without color.
  const symbol = state === 'reply' ? g.reply : waiting ? (selected ? g.onScreen : g.waiting) : state === 'in-triage' ? g.triage
    : state === 'answered' ? g.stored : state === 'delivered' ? g.delivered : state === 'read' ? g.read : state === 'closed' ? g.closed : g.waiting;
  const level = (m.state!.levels ?? []).find((l) => l.id === q.levelOf(c));
  const spans: Row['spans'] = [
    { text: selected ? `${g.marker} ` : '  ', style: st.bold },
    { text: `${symbol} `, style: waiting ? m.theme.level(level?.color) : st.dim },
  ];
  // A waiting card shows its level in words, at most five letters, in the level's color.
  if (q.waiting(state) && m.groupBy !== 'priority') spans.push({ text: pad(sanitize(q.levelOf(c)).slice(0, 5), 5) + ' ', style: m.theme.level(level?.color) });
  const fresh = m.fresh.has(c.id) ? ' new' : '';
  const used = spans.reduce((w, x) => w + textWidth(x.text), 0);
  const room = Math.max(4, width - used - textWidth(fresh));
  spans.push({ text: cut(m, sanitize(c.title), room), style: sent ? st.dim : {} });
  if (fresh) spans.push({ text: fresh, style: st.accent });
  return { spans, target: `list:${c.id}`, card: c.id, selected, dim: sent };
}

/** Draw the whole frame. */
export function drawFrame(m: Model): Frame {
  const grid = new Grid(m.width, m.height);
  const hits: Hit[] = [];
  const { s: st, g } = m.theme;
  const W = m.width;
  const H = m.height;
  // The bar: the name, the connection in words, the count waiting, and the help key.
  const waiting = m.queue?.pending.length ?? 0;
  grid.fill(0, 0, W, ' ', st.bar);
  let x = grid.text(1, 0, 'Your attention', { ...st.bar, bold: true });
  x = grid.text(x + 2, 0, m.connected ? `${g.read} Inbox connected` : m.connecting ? `${g.triage} Connecting` : `${g.closed} Inbox unreachable`, st.bar);
  if (m.queue) x = grid.text(x + 2, 0, `${waiting} waiting`, st.bar);
  const helpText = '? help  q quit';
  if (x + 2 + helpText.length < W) { grid.text(W - helpText.length - 1, 0, helpText, st.bar); hits.push({ x0: W - helpText.length - 1, x1: W - 7, y: 0, target: 'bar:help', col: 0, row: 0 }); }

  const bodyTop = 1;
  const bodyH = Math.max(1, H - 2);
  const lw = listWidth(W);
  const single = lw === 0;
  const showList = single ? m.zone === 'list' || !m.current : true;
  const showCard = single ? !showList : true;
  const listX = 0;
  const listW = single ? W : lw;
  const cardX = single ? 0 : lw + 1;
  const cardW = single ? W : W - lw - 1;
  const listCards: string[] = [];
  let cardLines = 0;

  if (m.blank) {
    const lines = m.blank.split('\n');
    lines.forEach((l, i) => grid.text(Math.max(1, Math.floor((W - textWidth(l)) / 2)), bodyTop + Math.floor(bodyH / 2) - Math.floor(lines.length / 2) + i, cut(m, l, W - 2), st.dim));
  } else {
    if (showList) {
      const rows = listRows(m, listW - 1);
      for (const r of rows) if (r.card) listCards.push(r.card);
      const maxScroll = Math.max(0, rows.length - bodyH);
      const at = m.revealList ? rows.findIndex((r) => r.selected) : -1;
      if (at >= 0 && at < m.listScroll + 1) m.listScroll = at - 3;
      else if (at >= 0 && at > m.listScroll + bodyH - 2) m.listScroll = at - bodyH + 3;
      m.revealList = false;
      m.listScroll = Math.min(Math.max(0, m.listScroll), maxScroll);
      for (let i = 0; i < bodyH; i++) {
        const r = rows[m.listScroll + i];
        if (!r) continue;
        const y = bodyTop + i;
        let cx = listX;
        for (const sp of r.spans) cx = grid.text(cx, y, sp.text, { ...sp.style, ...(r.dim && !r.selected ? st.dim : {}) }, listX + listW - 1);
        // The card on screen: inverse video while the list has the keys, bold otherwise. The marker shows either way.
        if (r.selected) grid.restyle(listX, y, listW - 1, m.zone === 'list' ? st.selected : { bold: true });
        if (r.target) hits.push({ x0: listX, x1: listX + listW - 1, y, target: r.target, col: 0, row: m.listScroll + i });
      }
      if (rows.length > bodyH) {
        if (m.listScroll > 0) grid.text(listX + listW - 2, bodyTop, g.up, st.dim);
        if (m.listScroll < maxScroll) grid.text(listX + listW - 2, bodyTop + bodyH - 1, g.down, st.dim);
      }
    }
    if (!single) for (let y = bodyTop; y < bodyTop + bodyH; y++) grid.text(lw, y, g.box.v, st.dim);
    if (showCard) {
      if (!m.current || !m.view || !m.state || !m.queue) {
        const msg = m.cleared && waiting ? 'No card selected. Pick a card from the list.' : 'Nothing needs you. New cards appear here on their own.';
        grid.text(cardX + 2, bodyTop + 1, cut(m, msg, cardW - 3), st.dim);
      } else {
        const doc = m.view.build(cardW - 3, m.state, m.queue);
        cardLines = doc.lines.length;
        const maxScroll = Math.max(0, doc.lines.length - bodyH);
        const stop = m.reveal && m.view.focus ? doc.stop(m.view.focus) : undefined;
        if (stop) {
          if (stop.top < m.cardScroll) m.cardScroll = Math.max(0, stop.top - 1);
          else if (stop.bottom >= m.cardScroll + bodyH) m.cardScroll = Math.min(stop.top - 1, stop.bottom - bodyH + 2);
        }
        m.reveal = false;
        m.cardScroll = Math.min(Math.max(0, m.cardScroll), maxScroll);
        hits.push(...drawLines(grid, doc.lines, cardX + 1, bodyTop, cardW - 3, bodyH, m.cardScroll));
        // A scroll bar of its own shape at the right edge, when the card is taller than the pane.
        if (doc.lines.length > bodyH) {
          const thumb = Math.max(1, Math.round((bodyH * bodyH) / doc.lines.length));
          const top = Math.round((m.cardScroll / maxScroll) * (bodyH - thumb));
          for (let i = 0; i < bodyH; i++) grid.text(W - 1, bodyTop + i, i >= top && i < top + thumb ? (m.theme.caps.unicode ? '┃' : '#') : (m.theme.caps.unicode ? '│' : '|'), st.dim);
        }
      }
    }
  }

  // The keys at the bottom, for where the keys go now, or a message.
  const y = H - 1;
  if (m.confirm) {
    grid.fill(0, y, W, ' ', st.bar);
    grid.text(1, y, cut(m, `${m.confirm}  y yes · n no`, W - 2), { ...st.bar, bold: true });
  } else if (m.status) {
    grid.text(1, y, cut(m, m.status.text, W - 2), m.status.kind === 'warn' ? st.error : m.status.kind === 'ok' ? { ...st.ok, bold: true } : st.dim);
  } else {
    const typing = m.zone === 'card' && m.view?.focused()?.text;
    const keys = m.zone === 'list'
      ? ['↑↓ cards', 'Enter answer', 'Ctrl+N skip', 'g group', '? help']
      : [typing ? 'Esc list' : 'Esc list', 'Tab next', 'Ctrl+S send', 'Ctrl+N skip', '? help'];
    const text = (m.theme.caps.unicode ? keys : keys.map((k) => k.replace('↑↓', 'j/k'))).join('  ');
    grid.text(1, y, cut(m, text, W - 2), st.dim);
  }

  if (m.help) drawHelp(grid, m);
  if (m.pin) drawPin(grid, m);
  return { grid, hits, listCards, listHeight: bodyH, cardHeight: bodyH, cardLines, listBox: { x: listX, w: showList ? listW : 0 }, cardBox: { x: cardX, w: showCard ? cardW : 0 } };
}

const HELP: [string, string][] = [
  ['In the list', ''],
  ['↑ ↓  j k', 'open the card above or below'],
  ['Enter  →  Tab', 'move into the card to answer it'],
  ['g', 'group by priority, agent or tag'],
  ['C', 'clear answered and closed cards'],
  ['o', 'open the card in the browser'],
  ['In the card', ''],
  ['Tab  Shift+Tab', 'next or previous field or button'],
  ['↑ ↓  Space  Enter', 'move in a choice and pick it'],
  ['PgUp PgDn', 'scroll the card'],
  ['Esc', 'back to the list'],
  ['Anywhere', ''],
  ['Ctrl+Enter  Ctrl+S', 'send the answer'],
  ['Ctrl+N', 'skip for now'],
  ['mouse', 'click cards, fields, buttons; wheel scrolls'],
  ['q  Ctrl+C', 'quit'],
];

function drawHelp(grid: Grid, m: Model): void {
  const { s: st, g } = m.theme;
  const w = Math.min(m.width - 4, 64);
  const h = Math.min(m.height - 2, HELP.length + 4);
  const x0 = Math.floor((m.width - w) / 2);
  const y0 = Math.max(1, Math.floor((m.height - h) / 2));
  box(grid, x0, y0, w, h, g.focusBox, st.focus);
  grid.text(x0 + 2, y0, ' Keys ', st.bold);
  HELP.slice(0, h - 4).forEach(([k, d], i) => {
    const y = y0 + 1 + i;
    const keyText = m.theme.caps.unicode ? k : k.replace(/↑/g, 'Up').replace(/↓/g, 'Down').replace(/→/g, 'Right');
    if (!d) { grid.text(x0 + 2, y, keyText, st.heading); return; }
    grid.text(x0 + 4, y, pad(keyText, 20), st.accent);
    grid.text(x0 + 25, y, cut(m, d, w - 27));
  });
  grid.text(x0 + 2, y0 + h - 2, cut(m, 'Any key closes this. No color: NO_COLOR=1 or --mono.', w - 4), st.dim);
}

function drawPin(grid: Grid, m: Model): void {
  const { s: st, g } = m.theme;
  const w = Math.min(m.width - 4, 46);
  const x0 = Math.floor((m.width - w) / 2);
  const y0 = Math.max(1, Math.floor(m.height / 2) - 3);
  box(grid, x0, y0, w, 6, g.focusBox, st.focus);
  grid.text(x0 + 2, y0 + 1, cut(m, 'This inbox is locked. Type its PIN:', w - 4), st.bold);
  const dots = (g.bullet + ' ').repeat(m.pin!.typed) + ('_ ').repeat(Math.max(0, 4 - m.pin!.typed));
  grid.text(x0 + 2, y0 + 2, dots, st.accent);
  if (m.pin!.message) grid.text(x0 + 2, y0 + 3, cut(m, m.pin!.message, w - 4), st.error);
  grid.text(x0 + 2, y0 + 4, cut(m, 'Enter unlocks · Ctrl+C quits', w - 4), st.dim);
}

function box(grid: Grid, x: number, y: number, w: number, h: number, b: { tl: string; tr: string; bl: string; br: string; h: string; v: string }, style: Style): void {
  for (let r = 0; r < h; r++) grid.fill(x, y + r, w, ' ');
  grid.text(x, y, b.tl + b.h.repeat(w - 2) + b.tr, style);
  grid.text(x, y + h - 1, b.bl + b.h.repeat(w - 2) + b.br, style);
  for (let r = 1; r < h - 1; r++) { grid.text(x, y + r, b.v, style); grid.text(x + w - 1, y + r, b.v, style); }
}
