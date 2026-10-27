// A sidecar that posts a card for each herdr agent blocked on a question or a
// permission prompt, and closes the card once the agent moves on. It works for
// any harness herdr detects.
//
// When the screen shows numbered choices, the card offers them. An answer on
// the card presses that choice's key in that agent's pane, and only after the
// sidecar reads the pane again and finds the same dialog still open. A dialog
// that changed or closed gets no key: a key sent to a working agent would
// interrupt it.
import { execFile } from 'node:child_process';
import { Client, loadConfig } from '../../client.ts';
import { randomId } from '../../core/crypto.ts';
import type { Answer, Card, NewCard } from '../../core/types.ts';
import { parseDialog, type Dialog } from './dialog.ts';

const POLL_MS = Number(process.env['HERDR_BLOCKED_POLL_MS'] ?? 2000);
const log = (...a: unknown[]): void => console.error(new Date().toISOString(), '[herdr-blocked]', ...a);

interface HerdrAgent {
  pane_id: string;
  tab_id: string;
  agent?: string;
  name?: string;
  agent_status: string;
}

export type Herdr = (...args: string[]) => Promise<string>;

const runHerdr: Herdr = (...args) => new Promise((resolve, reject) => {
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


/** Whether the pane's screen shows the dialog the card offers: the card's choices, and the same lines above them.
 * The card keeps its screen trimmed, so the pane's screen is trimmed the same way before both are read.
 * The lines above count: the same choices for another command are another question. */
function matchesCard(raw: string, card: Card): boolean {
  const offered = (card.options ?? []).map((o) => ({ key: o.id.slice(1), label: o.label }));
  const now = parseDialog(trimScreen(raw));
  const then = parseDialog(card.screen ?? '');
  return !!now && !!then && JSON.stringify(now.options) === JSON.stringify(offered) && JSON.stringify(then.options) === JSON.stringify(offered)
    && JSON.stringify(now.context) === JSON.stringify(then.context);
}

const sameDialog = (a: Dialog | undefined, b: Dialog | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The card fields that describe a blocked pane: its screen, and the dialog's choices when it shows one. */
function describe(screen: string, dialog: Dialog | undefined): Pick<NewCard, 'screen' | 'text' | 'options'> {
  return dialog
    ? { screen: trimScreen(screen), text: dialog.question, options: dialog.options.map((o) => ({ id: `o${o.key}`, label: o.label })) }
    : { screen: trimScreen(screen) };
}

export interface Sidecar {
  tick(): Promise<void>;
  /** Press the answered choice in its pane, if the same dialog still waits there. */
  answered(card: Card, answer: Answer): Promise<void>;
  stop(): void;
}

export function createSidecar(inbox: Client, herdr: Herdr = runHerdr, settleMs = 600): Sidecar {
  // pane id -> its card. An adopted card's dialog is read on the next tick, when it is checked against the card.
  const open = new Map<string, { card: Card; screen: string; dialog?: Dialog | undefined; adopted?: boolean; listen: AbortController }>();
  const readRaw = (pane: string): Promise<string> => herdr('pane', 'read', pane, '--lines', '60', '--source', 'detection').catch(() => '');
  const agents = async (): Promise<HerdrAgent[]> => (JSON.parse(await herdr('agent', 'list')) as { result: { agents: HerdrAgent[] } }).result.agents;
  let adopted = false;

  const listen = (card: Card): AbortController => {
    const ctl = new AbortController();
    void inbox.stream(card.agent, async (ev) => {
      if (ev.type === 'answer') await sidecar.answered(ev.card, ev.answer).catch((e: Error) => log('answer failed:', e.message));
    }, ctl.signal).catch((e: Error) => log('stream ended:', e.message));
    return ctl;
  };

  const forget = (pane: string): void => {
    open.get(pane)?.listen.abort();
    open.delete(pane);
  };

  const sidecar: Sidecar = {
    async tick() {
      if (!adopted) {
        // After a restart, take back the cards still open, so no pane gets a second card.
        adopted = true;
        for (const { card, state } of await inbox.list()) {
          const pane = card.origin?.herdrPane;
          if (card.kind !== 'blocked' || !pane || state === 'closed' || state === 'read') continue;
          open.set(pane, { card, screen: card.screen ?? '', adopted: true, listen: listen(card) });
        }
      }
      const blocked = (await agents()).filter((a) => a.agent_status === 'blocked');
      // A pane whose AskUserQuestion already has a card needs no second card.
      const askPanes = new Set((await inbox.list())
        .filter(({ card, state }) => card.questions && state === 'open' && card.origin?.herdrPane)
        .map(({ card }) => card.origin?.herdrPane));
      let labels: Record<string, string> | undefined;
      for (const a of blocked) {
        const known = open.get(a.pane_id);
        if (!known && askPanes.has(a.pane_id)) continue;
        const raw = await readRaw(a.pane_id);
        const dialog = parseDialog(raw);
        const fields = describe(raw, dialog);
        if (known?.adopted) {
          // A sidecar restart keeps the card's version when the pane still shows the dialog the card offers.
          known.adopted = false;
          if (dialog && matchesCard(raw, known.card)) { known.dialog = dialog; continue; }
        }
        if (known) {
          // A new dialog makes a new version, so an answer to the old one presses nothing. While the same dialog waits,
          // the rest of the screen can change, such as a clock, and the card keeps its version.
          const changed = dialog || known.dialog ? !sameDialog(dialog, known.dialog) : fields.screen !== known.screen;
          if (changed && fields.screen) {
            known.screen = fields.screen ?? '';
            known.dialog = dialog;
            const { attachments: _attachments, ...card } = known.card;
            known.card = await inbox.post({ ...card, ...fields, ...(fields.options ? {} : { options: undefined, text: undefined }) });
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
          ...fields,
          priority: 'now',
          origin: { harness: a.agent ?? 'agent', herdrPane: a.pane_id, name: where },
        });
        open.set(a.pane_id, { card, screen: fields.screen ?? '', dialog, listen: listen(card) });
        log('card', card.id, 'for', a.pane_id);
      }
      const still = new Set(blocked.map((a) => a.pane_id));
      for (const [pane, { card }] of open) {
        if (still.has(pane)) continue;
        forget(pane);
        await inbox.close(card.id, 'resolved', 'Answered in its session.', true).catch(() => {});
        log('closed', card.id);
      }
    },

    async answered(card, answer) {
      const pane = card.origin?.herdrPane;
      if (!pane || !/^[\w:]+$/.test(pane)) return;
      const label = card.options?.find((o) => o.id === answer.values['choice'])?.label;
      const refuse = async (why: string): Promise<void> => {
        await inbox.ack(card.id).catch(() => {});
        await inbox.close(card.id, 'resolved', why).catch(() => {});
        forget(pane);
        log('no key for', card.id, why);
      };
      if (!label) return refuse('The answer picked no choice, so no key was pressed. Answer it in its session.');
      if (answer.version !== card.version) return refuse('The dialog changed after you answered, so no key was pressed. A new card shows the current one.');
      const agent = (await agents()).find((a) => a.pane_id === pane);
      if (agent?.agent_status !== 'blocked') return refuse('The agent was no longer waiting, so no key was pressed.');
      const raw = await readRaw(pane);
      const dialog = parseDialog(raw);
      if (!dialog || !matchesCard(raw, card)) return refuse('The dialog changed before your answer arrived, so no key was pressed.');
      const key = dialog?.options.find((o) => o.label === label)?.key;
      if (!key) return refuse('That choice is no longer offered, so no key was pressed.');
      await herdr('agent', 'send-keys', pane, key);
      // Some dialogs act on the number alone, and others only move the selection to it. Confirm only when the same
      // dialog still waits: a new prompt for another command has other lines above its choices.
      await new Promise((r) => setTimeout(r, settleMs));
      if (sameDialog(parseDialog(await readRaw(pane)), dialog)) await herdr('agent', 'send-keys', pane, 'enter');
      await inbox.ack(card.id).catch(() => {});
      await inbox.close(card.id, 'resolved', `Pressed "${label}" in its session.`).catch(() => {});
      forget(pane);
      log('pressed', key, 'for', card.id);
    },

    stop() {
      for (const pane of [...open.keys()]) forget(pane);
    },
  };
  return sidecar;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('No inbox found. Start one with `your-attention serve`.');
  const sidecar = createSidecar(new Client(config));
  for (;;) {
    try { await sidecar.tick(); } catch (e) { log('tick failed:', (e as Error).message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
