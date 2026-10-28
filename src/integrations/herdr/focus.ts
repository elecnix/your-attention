// Opens a herdr session: the pane a card came from, or one a session link in a card points at.
// It moves focus only: no keys reach the agent.
import { execFile } from 'node:child_process';
import { parseSessionLink } from '../../core/session-link.ts';
import type { Card } from '../../core/types.ts';
import type { Herdr } from './blocked.ts';

const runHerdr: Herdr = (...args) => new Promise((resolve, reject) => {
  execFile(process.env['HERDR_BIN_PATH'] ?? 'herdr', args, { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out)));
});

export async function focusHerdrPane(card: Card, herdr: Herdr = runHerdr): Promise<void> {
  const pane = card.origin?.herdrPane;
  if (!pane || !/^[\w:]+$/.test(pane)) throw new Error('the card has no herdr pane');
  await herdr('agent', 'focus', pane);
}

/** Focus the session a link points at. herdr focuses a pane only through its agent, so a pane with no agent opens its tab. */
export async function focusSessionLink(href: string, herdr: Herdr = runHerdr): Promise<void> {
  const target = parseSessionLink(href);
  if (!target) throw new Error('not a session link');
  const { kind, id } = target;
  if (kind === 'tab' || kind === 'workspace') { await herdr(kind, 'focus', id); return; }
  if (kind === 'agent') { await herdr('agent', 'focus', id); return; }
  try {
    await herdr('agent', 'focus', id);
  } catch {
    const tab = (JSON.parse(await herdr('pane', 'get', id)) as { result: { pane: { tab_id: string } } }).result.pane.tab_id;
    await herdr('tab', 'focus', tab);
  }
}
