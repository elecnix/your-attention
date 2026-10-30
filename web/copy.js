// Code on the page copies with a click. A block copies through its Copy button, and inline code copies when clicked,
// except inside a link, where the click follows the link. One listener on the document handles both, so code that
// OpenUI draws copies the same as code the page draws. web/markdown.js draws the page's Copy buttons.
const FEEDBACK_MS = 1500;
const BLOCK = '.code-block, .openui-code-block-wrapper';
const BUTTON = '.copy-button, .openui-code-block-copy-button';

/** Copy through a hidden text area. A page that is not secure, such as one on a LAN address, has no navigator.clipboard. */
function copyByCommand(text) {
  const before = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  area.remove();
  if (before instanceof HTMLElement) before.focus({ preventScroll: true });
  return ok;
}

/** Put `text` on the clipboard, exactly as given. True when it copied. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  return copyByCommand(text);
}

const timers = new WeakMap();
let toast = null;
/** The word over inline code, at the code. It floats on the page, since the code may clip what overflows it. */
function showToast(el, word) {
  const r = el.getBoundingClientRect();
  toast.textContent = word;
  toast.dataset.tone = word === 'Copied' ? 'ok' : 'bad';
  toast.style.left = `${r.left + r.width / 2}px`;
  toast.style.top = `${r.top}px`;
  toast.dataset.show = '';
  toast.owner = el;
}

/** Show "Copied", or "Copy failed", on the element for a moment. A button says it in its accessible name too. */
function feedback(el, ok) {
  const word = ok ? 'Copied' : 'Copy failed';
  const button = el.matches(BUTTON);
  clearTimeout(timers.get(el));
  el.dataset.copied = word;
  if (button) el.setAttribute('aria-label', word);
  else showToast(el, word);
  timers.set(el, setTimeout(() => {
    delete el.dataset.copied;
    if (button) el.setAttribute('aria-label', 'Copy');
    else if (toast && toast.owner === el) { delete toast.dataset.show; toast.textContent = ''; }
  }, FEEDBACK_MS));
}

/** The text of the block a Copy button belongs to. OpenUI draws the code in its own element, with no code tag around it. */
function blockText(button) {
  const block = button.closest(BLOCK);
  const code = block && (block.querySelector('pre code') || block.querySelector('.openui-code-block-syntax-highlighter'));
  return code ? code.textContent : '';
}

/** Inline code that copies on a click: not in a block, and not in a link. */
function inlineCode(target) {
  const code = target instanceof Element ? target.closest('code') : null;
  return code && !code.closest(`pre, a, ${BLOCK}`) ? code : null;
}

let installed = false;
/** Listen on the document for clicks on code. Calling it again does nothing. */
export function installCopy() {
  if (installed) return;
  installed = true;
  // A live region on the page from the start, empty and clear until a copy, so a screen reader reads each word put in it.
  // It has no status role, which the page gives only to the message it shows, such as the PIN check.
  toast = document.createElement('div');
  toast.className = 'copy-toast';
  toast.setAttribute('aria-live', 'polite');
  document.body.append(toast);
  // OpenUI's own button copies only on a secure page and says "Copy code". The capture phase takes its click first.
  document.addEventListener('click', (e) => {
    const button = e.target instanceof Element ? e.target.closest(BUTTON) : null;
    if (button) {
      e.preventDefault();
      e.stopPropagation();
      void copyText(blockText(button)).then((ok) => feedback(button, ok));
      return;
    }
    const code = inlineCode(e.target);
    if (!code) return;
    // A person who selected part of the code wants that part, so the click leaves the selection alone.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && code.contains(sel.anchorNode)) return;
    void copyText(code.textContent).then((ok) => feedback(code, ok));
  }, true);
  // The hint goes on when the pointer arrives, so code that OpenUI draws gets it too.
  document.addEventListener('pointerover', (e) => {
    const code = inlineCode(e.target);
    if (code && !code.title) code.title = 'Click to copy';
  });
  // OpenUI's button is named "Copy code". It gets the page's name as it appears, and keeps it, since OpenUI never
  // draws the button again once the page takes its clicks.
  const rename = (root) => {
    for (const b of root.matches?.('.openui-code-block-copy-button') ? [root] : root.querySelectorAll?.('.openui-code-block-copy-button') ?? []) {
      if (b.dataset.copied) continue;
      b.setAttribute('aria-label', 'Copy');
      b.title = 'Copy';
    }
  };
  rename(document.body);
  new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) rename(n); })
    .observe(document.body, { childList: true, subtree: true });
}
