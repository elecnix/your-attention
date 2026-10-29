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
