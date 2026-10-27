// Reads the choice dialog an agent shows in its terminal, such as a permission
// prompt or a question, from the screen herdr reads. Pure, so tests feed it screens.

export interface Dialog {
  /** The lines just above the first choice, such as "Do you want to proceed?". */
  question: string;
  /** The choices, each with the key that picks it. */
  options: { key: string; label: string }[];
}

const OPTION = /^\s*(?:[❯›>▶]\s*)?(\d)\.\s+(.*\S)\s*$/;
// A choice that opens a text box needs typing, which a card answer cannot do safely.
const NEEDS_TYPING = /^(type something|chat about this)\b/i;

export function parseDialog(screen: string): Dialog | undefined {
  const lines = screen.replace(/\r/g, '').split('\n');
  // The dialog is the last run of choices numbered 1, 2, 3… on the screen.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (OPTION.exec(lines[i] ?? '')?.[1] === '1') { start = i; break; }
  if (start < 0) return undefined;
  const options: Dialog['options'] = [];
  for (let i = start; i < lines.length; i++) {
    const m = OPTION.exec(lines[i] ?? '');
    if (!m) continue;
    if (Number(m[1]) !== options.length + 1) return undefined;
    options.push({ key: m[1] ?? '', label: m[2] ?? '' });
  }
  if (options.length < 2) return undefined;
  const usable = options.filter((o) => !NEEDS_TYPING.test(o.label));
  if (!usable.length) return undefined;
  const above: string[] = [];
  for (let i = start - 1; i >= 0 && (lines[i] ?? '').trim(); i--) above.unshift((lines[i] ?? '').trim());
  return {
    question: above.filter((l) => !/^[☐☒✔]/.test(l)).join('\n'),
    options: usable,
  };
}
