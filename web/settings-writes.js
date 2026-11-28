// Group by and the pins change on a page, or in the terminal client, before the inbox stores them. Two races can then
// put an old value back on screen, or in the inbox:
//
// - A state the inbox built before it stored this client's write may arrive after the write settled. Its settings are
//   older than the client's, so a state applies its settings only when no write is in flight and its request started
//   after the last write settled. One counter orders the starts and the settles.
// - Two writes in flight at once may reach the inbox in either order, over two connections, and the inbox would then
//   keep the older value. So each write starts after the one before it settled.
//
// The page and the terminal client share this module, so both follow the same rule.

/** Order a client's settings writes and the states it reads. `send` performs one write and settles when the inbox answers. */
export function settingsWrites(send) {
  let clock = 0;
  let writing = 0;
  let settled = 0;
  let applied = 0;
  let queue = Promise.resolve();
  return {
    save(patch) {
      writing++;
      const done = queue.then(() => send(patch)).finally(() => {
        writing--;
        settled = ++clock;
      });
      queue = done.catch(() => {});
      return done;
    },
    started() {
      return ++clock;
    },
    settingsCurrent(started) {
      return writing === 0 && started > settled;
    },
    newest(started) {
      if (started <= applied) return false;
      applied = started;
      return true;
    },
  };
}
