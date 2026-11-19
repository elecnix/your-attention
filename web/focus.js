// Focus mode: the open card fills the screen while the person reads it. The page counts the cards that arrive meanwhile
// and raises one notification for them when focus ends. The page uses this file, and the unit tests read it without a browser.
import { notifies } from './queue.js';

const WAITING = ['open', 'orphaned', 'held'];

/** The cards that arrived while focus was on and now wait for the person, in the order the inbox lists them. `ids` are the
 * cards the inbox listed when focus began. */
export function arrivals(ids, live, cardId) {
  const known = new Set(ids);
  return live.cards.filter((c) => c.id !== cardId && !known.has(c.id) && WAITING.includes(live.states[c.id]));
}

/** The cards among `cards` that raise a notification: a card in a collapsed group stays quiet, unless it is at the highest level. */
export function notifiable(live, cards, groupBy, pins, collapsed) {
  return cards.filter((c) => notifies(live, c, collapsed, groupBy, pins));
}

/** The one notification the page raises when focus ends, or null when no card arrived. */
export function releaseNotice(cards) {
  if (!cards.length) return null;
  return {
    title: cards.length === 1 ? 'A card arrived while you focused' : `${cards.length} cards arrived while you focused`,
    body: cards.map((c) => c.title).join(' · '),
  };
}

/** Focus mode as this tab stored it: the card, the cards listed when focus began, and where the page and the queue were
 * scrolled, so leaving focus puts both back. Anything else reads as off, and a bad scroll position as the top. */
export function readFocusMode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { card, ids } = value;
  if (typeof card !== 'string' || !card || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
  const at = (y) => (typeof y === 'number' && Number.isFinite(y) && y > 0 ? y : 0);
  return { card, ids, pageY: at(value.pageY), queueY: at(value.queueY) };
}
