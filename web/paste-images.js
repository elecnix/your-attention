// Images the person pastes into an answer: which clipboard items count, which files the inbox accepts, and the
// thumbnails under a field. The state is per card, so a draft survives a re-render and a revision of the card.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;
// The answer route reads a body of at most 16 MB, and base64 makes an image four thirds of its size, so the images of
// one answer share a budget well under that. Ten images of 8 MB would be a body of 107 MB, which no route accepts.
export const IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;
export const IMAGE_COUNT_LIMIT = 10;

/** The files on a clipboard, in order, so checkImage can refuse the ones that aren't images. Text is left for the field. */
export function imageFiles(clipboard) {
  const out = [];
  for (const item of (clipboard && clipboard.items) || []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

/** Why the inbox would refuse this file, or null. */
export function checkImage(file) {
  const name = file.name || 'the pasted file';
  if (!IMAGE_TYPES.includes(file.type)) return `${name} is ${file.type || 'an unknown type'}: an answer takes only PNG, JPEG, GIF or WebP images.`;
  if (file.size > IMAGE_LIMIT_BYTES) return `${name} is over the limit of 8 MB.`;
  return null;
}

/** Megabytes, as the person reads them, for a message about a size. */
const mb = (n) => `${Math.round(n / (1024 * 1024))} MB`;

/** The problem with adding `file` to a draft that already holds `have`, or null when it fits. */
export function draftProblem(have, file) {
  const problem = checkImage(file);
  if (problem) return problem;
  if (have.length >= IMAGE_COUNT_LIMIT) return `An answer takes at most ${IMAGE_COUNT_LIMIT} images.`;
  const total = have.reduce((n, i) => n + (i.size || 0), 0) + file.size;
  if (total > IMAGE_TOTAL_BYTES) return `These images add up to ${mb(total)}, and an answer takes at most ${mb(IMAGE_TOTAL_BYTES)} of images.`;
  return null;
}

const drafts = new Map(); // card id -> [{key, name, field, src, url, size}], where url is the blob address a new tab opens
let counter = 0;

export const pastedImages = {
  list: (cardId) => drafts.get(cardId) || [],
  /** Add a file to a card's draft. Returns the problem, or null. */
  async add(cardId, field, file) {
    const early = draftProblem(drafts.get(cardId) || [], file);
    if (early) return early;
    const src = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('the browser could not read the image'));
      r.readAsDataURL(file);
    });
    // Read the draft again: a second paste or a drop can land while this one decodes, and the list read before the
    // await would drop that image when this one is written back.
    const have = drafts.get(cardId) || [];
    const late = draftProblem(have, file);
    if (late) return late;
    counter += 1;
    drafts.set(cardId, [...have, { key: `img${counter}`, name: file.name && file.name !== 'image.png' ? file.name : `pasted-${counter}.${file.type.slice(6).replace('jpeg', 'jpg')}`, field, src, url: URL.createObjectURL(file), size: file.size }]);
    return null;
  },
  remove(cardId, key) {
    const have = drafts.get(cardId) || [];
    for (const i of have) if (i.key === key) URL.revokeObjectURL(i.url);
    drafts.set(cardId, have.filter((i) => i.key !== key));
  },
  clear(cardId) {
    for (const i of drafts.get(cardId) || []) URL.revokeObjectURL(i.url);
    drafts.delete(cardId);
  },
  /** What the answer route takes. */
  payload: (cardId) => (drafts.get(cardId) || []).map(({ src, name, field }) => ({ src, name, field })),
};

/** The strip under a field's own box, where its thumbnails and any refusal show. */
function stripAfter(el, field) {
  const box = el.closest('label') || el;
  let strip = box.nextElementSibling;
  if (!(strip && strip.matches('[data-pasted-strip]'))) {
    strip = document.createElement('div');
    strip.setAttribute('data-pasted-strip', field);
    strip.className = 'pasted-strip';
    box.insertAdjacentElement('afterend', strip);
  }
  return strip;
}

/** Draw the strips of one card from its draft. A strip with nothing in it is removed. */
export function drawStrips(cardId) {
  const items = pastedImages.list(cardId);
  for (const strip of document.querySelectorAll('[data-pasted-strip]')) {
    const field = strip.getAttribute('data-pasted-strip');
    const mine = items.filter((i) => i.field === field);
    const note = strip.getAttribute('data-note') || '';
    strip.replaceChildren();
    for (const img of mine) {
      const fig = document.createElement('figure');
      fig.className = 'pasted-thumb';
      const pic = document.createElement('img');
      pic.src = img.src;
      pic.alt = `Pasted image ${img.name}`;
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'pasted-remove';
      drop.textContent = '×';
      drop.setAttribute('aria-label', `Remove ${img.name}`);
      drop.addEventListener('click', () => { pastedImages.remove(cardId, img.key); drawStrips(cardId); });
      const open = document.createElement('a');
      open.href = img.url;
      open.target = '_blank';
      open.rel = 'noopener';
      open.title = `Open ${img.name} in a new tab`;
      open.append(pic);
      fig.append(open, drop);
      strip.append(fig);
    }
    if (note) {
      const p = document.createElement('div');
      p.className = 'note warn';
      p.setAttribute('role', 'alert');
      p.textContent = note;
      strip.append(p);
    }
    // A strip whose paste is still decoding stays, or its thumbnail would appear nowhere and its refusal note would
    // be written to a node no one shows.
    if (!mine.length && !note && !strip.hasAttribute('data-pending')) strip.remove();
  }
}

/** Remove every strip and forget the card's draft, after the answer is sent. */
export function clearPasted(cardId) {
  pastedImages.clear(cardId);
  for (const strip of document.querySelectorAll('[data-pasted-strip]')) strip.remove();
}

/** The text field of the card on screen that an event landed on, or null. */
function fieldOf(e, currentCard) {
  const el = e.target instanceof Element ? e.target.closest('textarea, input') : null;
  if (!el || !currentCard() || !el.closest('.focus-card') || (el.type && !['text', 'search', 'url', 'email', 'textarea'].includes(el.type))) return null;
  return el;
}

/** Add the files to the card's draft under the field they landed on, and show thumbnails or the refusal. */
async function take(el, cardId, files) {
  const field = el.getAttribute('name') || el.id || 'answer';
  const strip = stripAfter(el, field);
  strip.setAttribute('data-pending', '1');
  const problems = [];
  try {
    for (const file of files) {
      const problem = await pastedImages.add(cardId, field, file).catch((err) => String(err.message || err));
      if (problem) problems.push(problem);
    }
    strip.setAttribute('data-note', problems.join(' '));
  } finally {
    strip.removeAttribute('data-pending');
  }
  drawStrips(cardId);
}

/** Paste or drop an image on any text field of the card on screen. Text on the clipboard still pastes as text. */
export function installPaste(currentCard) {
  document.addEventListener('paste', (e) => {
    const el = fieldOf(e, currentCard);
    const files = el ? imageFiles(e.clipboardData) : [];
    if (!files.length) return;
    if (![...e.clipboardData.items].some((i) => i.kind === 'string' && i.type === 'text/plain')) e.preventDefault();
    take(el, currentCard(), files);
  });
  // A field only receives a drop when dragover is cancelled, and the browser would otherwise open the file.
  const dragsFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  document.addEventListener('dragover', (e) => {
    if (dragsFiles(e) && fieldOf(e, currentCard)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const el = dragsFiles(e) ? fieldOf(e, currentCard) : null;
    if (!el) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.length) take(el, currentCard(), files);
  });
}
