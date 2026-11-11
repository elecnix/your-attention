// The whole cards a client shows. GET /v1/state sends a summary of each card, and the page and the terminal client fetch
// the whole card from GET /v1/cards/<id> when it opens, with the card after it, so moving on stays instant. A copy is
// current while its rev matches the summary's. A copy that is out of date stays on screen until the new one arrives.
// The page and the terminal client share this file, so both fetch the same way.

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
