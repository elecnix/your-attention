// Reads the choice dialog an agent shows in its terminal, such as a permission
// prompt or a question, from the screen herdr reads. Pure, so tests feed it screens.

export interface Dialog {
  /** The question line, such as "Do you want to proceed?", and any lines after it before the first choice. */
  question: string;
  /** The dialog's lines above the choices, such as the command a permission prompt asks about. */
  context: string[];
  /** The choices, each with the key that picks it. */
  options: { key: string; label: string }[];
}

const MAX_GAP = 3;
// Without a box border, the context stops after this many lines, so a whole conversation never counts as one dialog.
const MAX_CONTEXT = 12;
// A box border may be this far above the choices, so a tall command still counts as the dialog.
const MAX_BOX = 40;
const TOP_BORDER = /^\s*[╭┌╔]?[─━═]{8,}[╮┐╗]?\s*$/;
const RULE = /^[\s─━═╌┄╰╯└┘╚╝-]+$/;
const SIDES = /^[│┃║]\s?|\s?[│┃║]$/g;
const OPTION = /^\s*[│┃║]?\s*(?:[❯›>▶]\s*)?(\d)\.\s+(.*?\S)\s*[│┃║]?\s*$/;
// A choice that opens a text box needs typing, which a card answer cannot do safely.
const NEEDS_TYPING = /^(type something|chat about this)\b/i;

export function parseDialog(screen: string): Dialog | undefined {
  const lines = screen.replace(/\r/g, '').split('\n');
  // The dialog is the last run of choices numbered 1, 2, 3… on the screen.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (OPTION.exec(lines[i] ?? '')?.[1] === '1') { start = i; break; }
  if (start < 0) return undefined;
  const options: Dialog['options'] = [];
  let gap = 0;
  for (let i = start; i < lines.length; i++) {
    const m = OPTION.exec(lines[i] ?? '');
    // A choice may carry a description of a line or two. A longer gap ends the dialog, so two numbered runs never merge.
    if (!m) { if (++gap > MAX_GAP) break; continue; }
    if (Number(m[1]) !== options.length + 1) return undefined;
    options.push({ key: m[1] ?? '', label: m[2] ?? '' });
    gap = 0;
  }
  if (options.length < 2) return undefined;
  const usable = options.filter((o) => !NEEDS_TYPING.test(o.label));
  if (!usable.length) return undefined;
  // The context runs up from the first choice to the box's top border, across blank lines. Without a border
  // close enough, it stops after MAX_CONTEXT lines. The question comes from the nearest block above the choices.
  let top = -1;
  for (let i = start - 1; i >= 0 && i >= start - MAX_BOX; i--) if (TOP_BORDER.test(lines[i] ?? '')) { top = i; break; }
  const context: string[] = [];
  const block: string[] = [];
  let inBlock = true;
  for (let i = start - 1; i > top && (top >= 0 || context.length < MAX_CONTEXT); i--) {
    const l = (lines[i] ?? '').trim().replace(SIDES, '').trim();
    if (!l) { if (block.length) inBlock = false; continue; }
    if (RULE.test(l) || /^[☐☒✔]/.test(l)) continue;
    context.unshift(l);
    if (inBlock) block.unshift(l);
  }
  const asked = block.map((l) => l.endsWith('?')).lastIndexOf(true);
  return {
    question: (asked >= 0 ? block.slice(asked) : block.slice(-1)).join('\n'),
    context,
    options: usable,
  };
}
