// Focus mode: while the person reads one card, the page shows the queue as it stood when focus began, and only the
// open card itself follows the inbox. Everything else waits until focus ends. The page uses this file, and the unit
// tests read it without a browser.
import { buildQueue } from './queue.js';

const WAITING = ['open', 'orphaned', 'held'];

/** The state the page draws while focus is on: the held state, with the open card's summary, state and answer from the
 * live one. The open card keeps its held priority, so a revision that raises it does not move the card in the queue. */
export function holdView(held, live, cardId) {
  const now = live.cards.find((c) => c.id === cardId);
  const before = held.cards.find((c) => c.id === cardId);
  if (!now || !before) return held;
  const answers = { ...held.answers };
  if (live.answers[cardId]) answers[cardId] = live.answers[cardId]; else delete answers[cardId];
  return {
    ...held,
    cards: held.cards.map((c) => (c.id === cardId ? { ...now, priority: before.priority } : c)),
    states: { ...held.states, [cardId]: live.states[cardId] },
    answers,
  };
}

/** The held state after a reload: the live state with only the cards that were listed when focus began. */
export function heldFrom(live, ids) {
  const keep = new Set(ids);
  return { ...live, cards: live.cards.filter((c) => keep.has(c.id)) };
}

/** The cards that arrived while focus was on and now wait for the person, in the order the inbox lists them. */
export function arrivals(held, live, cardId) {
  const known = new Set(held.cards.map((c) => c.id));
  return live.cards.filter((c) => c.id !== cardId && !known.has(c.id) && WAITING.includes(live.states[c.id]));
}

/** The cards among `cards` that raise a notification: a card in a collapsed group stays quiet, unless it is at the highest level. */
export function notifiable(live, cards, groupBy, pins, collapsed) {
  const q = buildQueue(live, groupBy, pins, collapsed);
  const top = (live.levels || [])[0];
  return cards.filter((c) => !q.hidden.has(c.id) || (top && q.levelOf(c) === top.id));
}

/** The one notification the page raises when focus ends, or null when no card arrived. */
export function releaseNotice(cards) {
  if (!cards.length) return null;
  return {
    title: cards.length === 1 ? 'A card arrived while you focused' : `${cards.length} cards arrived while you focused`,
    body: cards.map((c) => c.title).join(' · '),
  };
}

/** Focus mode as this tab stored it, `{card, ids}`, or null for anything else. */
export function readFocusMode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { card, ids } = value;
  if (typeof card !== 'string' || !card || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
  return { card, ids };
}
