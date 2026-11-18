// The whole cards a client shows. GET /v1/state sends a summary of each card, and the page and the terminal client fetch
// the whole card from GET /v1/cards/<id> when it opens, with the card after it, so moving on stays instant. A copy is
// current while its rev matches the summary's. A copy that is out of date stays on screen until the new one arrives.
// The page and the terminal client share this file, so both fetch the same way.

import { ownCardId } from './answers.js';
import { linkHrefs } from './markdown.js';
import { CLOSED_LABEL } from './queue.js';

/** `load(id)` resolves to `{card, answer, state, rev}`. `changed()` runs when a fetch ends. */
export function cardDetails(load, changed) {
  const copies = new Map();
  const loading = new Map();
  return {
    /** The copy of a card, current or not, or undefined before the first fetch ends. */
    get(summary) {
      const copy = summary ? copies.get(summary.id) : undefined;
      return copy ? copy.detail : undefined;
    },
    /** Whether a fetch of this card has ended, with its copy or without one. */
    tried(id) {
      return copies.has(id);
    },
    /** Fetch each card whose copy is missing or older than its summary. */
    want(summaries) {
      for (const s of summaries) {
        if (!s) continue;
        const copy = copies.get(s.id);
        if ((copy && copy.rev === s.rev) || loading.get(s.id) === s.rev) continue;
        loading.set(s.id, s.rev);
        Promise.resolve().then(() => load(s.id)).then(
          (detail) => { copies.set(s.id, { rev: detail.rev ?? s.rev, detail }); },
          // A card that is gone keeps no copy, and the next summary of it fetches again.
          () => { if (!copies.has(s.id)) copies.set(s.id, { rev: s.rev, detail: undefined }); },
        ).finally(() => { if (loading.get(s.id) === s.rev) loading.delete(s.id); changed(); });
      }
    },
    /** Forget the cards the state no longer shows. */
    keep(ids) {
      for (const id of copies.keys()) if (!ids.has(id)) copies.delete(id);
    },
  };
}

/** The ids a text links to with [[card-id]], as the inbox reads them for a summary's `links`. */
export const linkIds = (...texts) => [...new Set(texts.filter(Boolean).flatMap((t) => [...String(t).matchAll(/\[\[([\w.:-]{1,80})\]\]/g)].map((m) => m[1])))];

/** The ids a text links to by this inbox's own card address, http://<inbox>/#card=<id>, so the page asks about the ones
 * the state leaves out in the same batches as the [[card-id]] links. It reads the links the renderer draws, so each id is
 * the one the link opens. */
export const ownLinkIds = (here, ...texts) => [...new Set(texts.filter(Boolean).flatMap((t) => linkHrefs(t).map((href) => ownCardId(href, here)).filter(Boolean)))];

// A link to an agent's card says which way that card ended. Each close kind the agent picks takes the card back, except
// answered in the terminal, where the person did answer, only somewhere else. A card still waiting shows nothing: an
// unmarked link is a live question, and a marker on every open link would hide the ones that ended.
const TAKEN_BACK = new Set(['retracted', 'self-answered', 'resolved']);
const ENDED = { dismissed: ['dismissed', 'Dismissed'], expired: ['expired', 'Expired'], returned: ['sent back', 'Sent back to its agent'] };
const when = (at) => (at ? ` on ${new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '');

/** The `{state, kind, at}` of a card in GET /v1/state, from its summary, its state and its answer, the same outcome
 * GET /v1/cards?ids= returns for a card the state leaves out. */
export function summaryOutcome(card, state, answer) {
  if (!card || !state) return undefined;
  if (state === 'closed') return { state, kind: card.closed?.kind, at: card.closed?.at };
  return answer ? { state, at: answer.savedAt } : { state };
}

/** The marker of a link to a card with this `{state, kind, at}`: `{key, word, title}`, or null for a card still waiting.
 * `word` shows next to the title, and `title` starts the hover with the outcome and its time. */
export function linkOutcome(outcome) {
  if (!outcome) return null;
  const { state, kind, at } = outcome;
  if (state === 'answered' || state === 'delivered' || state === 'read') return { key: 'answered', word: 'answered', title: `Answered${when(at)}` };
  if (state !== 'closed') return null;
  if (kind === 'answered-in-terminal') return { key: 'answered', word: 'answered', title: `Answered in the terminal${when(at)}` };
  if (TAKEN_BACK.has(kind)) return { key: 'taken-back', word: 'taken back', title: `Taken back (${CLOSED_LABEL[kind].toLowerCase()})${when(at)}` };
  const [word, label] = ENDED[kind] || ['closed', 'Closed'];
  return { key: kind in ENDED ? kind : 'closed', word, title: `${label}${when(at)}` };
}

/** Cards a text links to that the state leaves out, such as a card the person cleared. `want(ids)` asks the inbox for every
 * id it has not asked about yet in one request, GET /v1/cards?ids=. `get(id)` is the card's `{title, preview, archivedAt}`,
 * null when the inbox does not store it, or undefined before the answer arrives. */
export function linkLookup(load, changed) {
  const found = new Map();
  return {
    get: (id) => found.get(id),
    want(ids) {
      const ask = ids.filter((id) => !found.has(id)).slice(0, 20);
      if (!ask.length) return;
      // Asked once: an id stays pending until the answer, so the next draw asks for nothing again.
      for (const id of ask) found.set(id, undefined);
      Promise.resolve().then(() => load(ask)).then(
        (cards) => { for (const id of ask) found.set(id, Object.hasOwn(cards, id) ? cards[id] : null); },
        // A failed request is not asked again until the page reloads, so a broken lookup cannot loop; the links show their ids.
        () => { for (const id of ask) found.set(id, null); },
      ).finally(changed);
    },
  };
}
