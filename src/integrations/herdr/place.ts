// The herdr workspace and tab a pane sits in, by the labels herdr shows, so a card
// can tell the person where to find its agent when "Open session" does not work.
import { execFile } from 'node:child_process';
import type { Origin } from '../../core/types.ts';
import type { Herdr } from './blocked.ts';

const runHerdr: Herdr = (...args) => new Promise((resolve, reject) => {
  execFile(process.env['HERDR_BIN_PATH'] ?? 'herdr', args, { timeout: 2000 }, (err, out) => (err ? reject(err) : resolve(out)));
});

/** Looked up at each post, because the person can move or rename tabs while the agent runs. Empty when herdr does not answer. */
export async function herdrPlace(pane: string | undefined, herdr: Herdr = runHerdr): Promise<Pick<Origin, 'herdrWorkspace' | 'herdrTab'>> {
  if (!pane || !/^[\w:]+$/.test(pane)) return {};
  try {
    const at = (JSON.parse(await herdr('pane', 'current', '--pane', pane)) as { result: { pane: { tab_id: string; workspace_id: string } } }).result.pane;
    const tab = (JSON.parse(await herdr('tab', 'get', at.tab_id)) as { result: { tab: { label?: string } } }).result.tab;
    const workspace = (JSON.parse(await herdr('workspace', 'get', at.workspace_id)) as { result: { workspace: { label?: string } } }).result.workspace;
    return { herdrWorkspace: workspace.label || undefined, herdrTab: tab.label || undefined };
  } catch {
    return {};
  }
}
