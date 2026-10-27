// A sidecar that posts a card for each herdr agent blocked on a question or a
// permission prompt, and closes the card once the agent moves on. It works for
// any harness herdr detects. It reads herdr only and sends no keys.
import { execFile } from 'node:child_process';
import { Client, loadConfig } from '../../client.ts';
import { randomId } from '../../core/crypto.ts';
import type { Card } from '../../core/types.ts';

const POLL_MS = Number(process.env['HERDR_BLOCKED_POLL_MS'] ?? 2000);
const log = (...a: unknown[]): void => console.error(new Date().toISOString(), '[herdr-blocked]', ...a);

interface HerdrAgent {
  pane_id: string;
  tab_id: string;
  agent?: string;
  name?: string;
  agent_status: string;
}

const herdr = (...args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(process.env['HERDR_BIN_PATH'] ?? 'herdr', args, { maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
});

/** The screen herdr uses to detect the block, trimmed to what a card needs. */
export function trimScreen(raw: string): string {
  return raw.split('\n')
    .filter((l) => l.trim() && !/Debug mode enabled/.test(l))
    .map((l) => (/^[\s─━═-]+$/.test(l) ? '─'.repeat(40) : l.trimEnd()))
    .slice(-25)
    .join('\n');
}

export async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('No inbox found. Start one with `your-attention serve`.');
  const inbox = new Client(config);
  const open = new Map<string, { card: Card; screen: string }>(); // pane id -> its card

  const readScreen = async (pane: string): Promise<string> =>
    trimScreen(await herdr('pane', 'read', pane, '--lines', '60', '--source', 'detection').catch(() => ''));

  async function tick(): Promise<void> {
    const agents = (JSON.parse(await herdr('agent', 'list')) as { result: { agents: HerdrAgent[] } }).result.agents;
    const blocked = agents.filter((a) => a.agent_status === 'blocked');
    // A pane whose AskUserQuestion already has a card needs no second card.
    const askPanes = new Set((await inbox.list())
      .filter(({ card, state }) => card.questions && state === 'open' && card.origin?.herdrPane)
      .map(({ card }) => card.origin?.herdrPane));
    let labels: Record<string, string> | undefined;
    for (const a of blocked) {
      const known = open.get(a.pane_id);
      if (!known && askPanes.has(a.pane_id)) continue;
      const screen = await readScreen(a.pane_id);
      if (known) {
        // Keep the screen on the card current while the agent waits.
        if (screen && screen !== known.screen) {
          known.screen = screen;
          const { attachments: _attachments, ...card } = known.card;
          known.card = await inbox.post({ ...card, screen });
        }
        continue;
      }
      labels ??= Object.fromEntries((JSON.parse(await herdr('tab', 'list')) as { result: { tabs: { tab_id: string; label: string }[] } }).result.tabs.map((t) => [t.tab_id, t.label]));
      const where = labels[a.tab_id] ?? a.name ?? a.pane_id;
      const card = await inbox.post({
        id: `blocked-${randomId(4)}`,
        agent: `herdr:${a.pane_id}`,
        kind: 'blocked',
        title: `${where} is waiting for you`,
        screen,
        priority: 'now',
        deliver: 'none',
        origin: { harness: a.agent ?? 'agent', herdrPane: a.pane_id, name: where },
      });
      open.set(a.pane_id, { card, screen });
      log('card', card.id, 'for', a.pane_id);
    }
    const still = new Set(blocked.map((a) => a.pane_id));
    for (const [pane, { card }] of open) {
      if (still.has(pane)) continue;
      open.delete(pane);
      await inbox.close(card.id, 'resolved', 'Answered in its session.', true).catch(() => {});
      log('closed', card.id);
    }
  }

  for (;;) {
    try { await tick(); } catch (e) { log('tick failed:', (e as Error).message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
