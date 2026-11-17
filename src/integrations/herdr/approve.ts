// Types a sentence the person approved on a card into a herdr pane, as the person's own message.
// It sends only to a pane herdr knows, and never over text the person typed in that pane's input box.
import { execFile } from 'node:child_process';
import { PANE_ID, type ApprovalSender } from '../../core/inbox.ts';
import type { ApprovalPlace } from '../../core/types.ts';
import type { Herdr } from './blocked.ts';

/** Run one herdr command, for the integrations that send into a pane. */
export const runHerdr: Herdr = (...args) => new Promise((resolve, reject) => {
  execFile(process.env['HERDR_BIN_PATH'] ?? 'herdr', args, { timeout: 5000, maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
});

/** Footer hints that reuse the input box glyph, and are not the box. */
const HINTS = [/^Press up to edit queued/, /^ctrl\+enter to send now/, /^paste again to expand/];

/** Whether the escape sequences turn on faint, SGR 2. In 38;2;r;g;b and 48;2;r;g;b the 2 picks a color model instead. */
function faint(raw: string): boolean {
  for (const m of raw.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const ps = (m[1] ?? '').split(';');
    for (let i = 0; i < ps.length; i++) {
      if (ps[i] === '38' || ps[i] === '48' || ps[i] === '58') { i += ps[i + 1] === '2' ? 4 : ps[i + 1] === '5' ? 2 : 0; continue; }
      if (ps[i] === '2') return true;
    }
  }
  return false;
}

/** What a Claude Code or Codex pane's input box holds. Claude Code and Codex draw a suggestion faint, so a faint text is
 * a GHOST the send may replace, and any other text is the person's DRAFT. The box is the last line with the box glyph:
 * the earlier ones are past messages. */
export function boxState(ansi: string): { state: 'EMPTY' | 'GHOST' | 'DRAFT' | 'NO-BOX'; text: string } {
  let found: { state: 'EMPTY' | 'GHOST' | 'DRAFT'; text: string } | undefined;
  for (const line of ansi.split(/\r?\n/)) {
    const m = /(?:❯|›)(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[1] ?? '';
    const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (HINTS.some((h) => h.test(text))) continue;
    found = { state: text === '' ? 'EMPTY' : faint(raw) ? 'GHOST' : 'DRAFT', text };
  }
  return found ?? { state: 'NO-BOX', text: '' };
}

/** How often, and how many times, a send reads the box again while it still shows the text sent before. */
const SETTLE_MS = 100;
const SETTLE_READS = 30;

const words = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Whether the box shows `sent`, or its first line when the text wraps. */
const shows = (box: string, sent: string | undefined): boolean => !!sent && !!words(box) && words(sent).startsWith(words(box));

export function herdrApprovals(herdr: Herdr = runHerdr, opts: { pause?: (ms: number) => Promise<void> } = {}): ApprovalSender {
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The last text this sender typed into each pane. `agent prompt` returns once the pane accepts it, and the box keeps
  // showing it a moment longer, so a second approval to the same pane waits for the box to clear instead of taking that
  // text for the person's draft.
  const sent = new Map<string, string>();
  const readBox = async (pane: string) => boxState(await herdr('pane', 'read', pane, '--lines', '40', '--source', 'visible', '--format', 'ansi'));
  const paneInfo = async (pane: string): Promise<Record<string, string | undefined>> => {
    if (!PANE_ID.test(pane)) throw new Error(`${pane} is not a herdr pane id`);
    return (JSON.parse(await herdr('pane', 'get', pane)) as { result: { pane: Record<string, string | undefined> } }).result.pane;
  };
  return {
    async send(pane, text) {
      try { await paneInfo(pane); } catch { throw new Error(`herdr has no pane ${pane}`); }
      let box = await readBox(pane);
      for (let n = 0; box.state === 'DRAFT' && shows(box.text, sent.get(pane)) && n < SETTLE_READS; n++) {
        await pause(SETTLE_MS);
        box = await readBox(pane);
      }
      if (box.state === 'NO-BOX') throw new Error(`pane ${pane} shows no input box, so nothing was sent`);
      if (box.state === 'DRAFT' && shows(box.text, sent.get(pane))) throw new Error(`the input box in pane ${pane} still shows the approval sent before, so nothing was sent: once it clears, answer again`);
      if (box.state === 'DRAFT') throw new Error(`the input box in pane ${pane} holds a draft you typed, so nothing was sent: send or clear it, then answer again`);
      await herdr('agent', 'prompt', pane, text);
      sent.set(pane, text);
    },
    async describe(pane) {
      try {
        const p = await paneInfo(pane);
        const label = async (kind: 'tab' | 'workspace', id: string | undefined): Promise<string | undefined> => {
          if (!id) return undefined;
          try { return (JSON.parse(await herdr(kind, 'get', id)) as { result: Record<string, { label?: string }> }).result[kind]?.label || undefined; } catch { return undefined; }
        };
        const place: ApprovalPlace = { agent: p['agent'] || undefined, title: p['terminal_title_stripped'] || undefined, tab: await label('tab', p['tab_id']), workspace: await label('workspace', p['workspace_id']) };
        return Object.fromEntries(Object.entries(place).filter(([, v]) => v)) as ApprovalPlace;
      } catch {
        return {};
      }
    },
  };
}
