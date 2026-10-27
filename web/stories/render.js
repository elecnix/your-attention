// Mounts one React element from the page into a story's root.
export function mount(element) {
  const root = document.createElement('div');
  root.className = 'focus-card';
  window.__OpenUI.createRoot(root).render(element);
  return root;
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
export const dataUrl = (type, text) => `data:${type};base64,${b64(text)}`;
export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A card with every required field, for stories. Values are invented. */
export function card(over = {}) {
  return { id: 'c1', agent: 'claude:demo', kind: 'ask', title: 'Store sessions in SQLite or Postgres?', priority: 'now', deliver: 'stream', version: 1, createdAt: Date.now() - 60000, updatedAt: Date.now(), replies: [], ...over };
}
