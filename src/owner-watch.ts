// `your-attention watch --role owner`: follow the page events with an owner token, as the page and the terminal client
// do, and print each one as a line. Both builds send page events over the page socket, so the watcher works with the
// laptop inbox and the hosted one. It opens the socket without a page id, so the inbox does not count it as a page
// that someone looks at, and extensions that read `GET /v1/person` never take a script for the person.
import type { PageEvent } from './core/types.ts';
import { InboxApi } from './tui/api.ts';
import { keepEvent, ownerEvent, ownerLine, type CardDetail, type OwnerEvent, type OwnerLine, type WatchFilter, type WatchOptions } from './watch.ts';

/** Check that the token is an owner's: the page socket refuses any other, and a refused socket only retries.
 * Throws the inbox's `ApiError`, with status 401 for a token the inbox does not know and 403 for an agent's. */
export async function checkOwner(config: { url: string; token: string }): Promise<void> {
  await new InboxApi(config).call('GET', '/v1/pin');
}

/** Print each owner event that passes the filter, until `signal` aborts. */
export function watchOwner(config: { url: string; token: string }, opts: { options: WatchOptions; filter: WatchFilter; write: (line: OwnerLine) => void; signal: AbortSignal }): Promise<void> {
  const api = new InboxApi(config);
  // The page refetches on every change, so one answer can bring several. A change whose card has the same `rev` as the
  // line before it says nothing new, and the watcher skips it.
  const revs = new Map<string, string>();
  // One event at a time, so the lines come in the order the inbox sent the events.
  let queue = Promise.resolve();
  const emit = (event: OwnerEvent): void => {
    if (keepEvent(event, opts.filter)) opts.write(ownerLine(event, opts.options, Date.now()));
  };
  const handle = async (event: Exclude<PageEvent, { type: 'beat' }>): Promise<void> => {
    if (event.type !== 'change' || !event.card) return emit(ownerEvent(event, undefined));
    const detail = await api.call<CardDetail>('GET', `/v1/cards/${encodeURIComponent(event.card)}`).catch(() => undefined);
    if (detail?.rev !== undefined) {
      if (revs.get(event.card) === detail.rev) return;
      revs.set(event.card, detail.rev);
    }
    emit(ownerEvent(event, detail));
  };
  const enqueue = (work: () => void | Promise<void>): void => { queue = queue.then(work).catch(() => {}); };
  // A signal can abort before the watcher starts, as a Ctrl-C during `checkOwner` does, and an abort event never comes again.
  if (opts.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = api.live(
      (type, event) => {
        if (!event || type === 'beat') return;
        enqueue(() => handle(event as Exclude<PageEvent, { type: 'beat' }>));
      },
      () => {},
      { viewer: false, onOpen: () => enqueue(() => emit({ type: 'hello', role: 'owner' })) },
    );
    opts.signal.addEventListener('abort', () => { stop(); resolve(); }, { once: true });
  });
}
