// Claude Code hooks for AskUserQuestion.
// ask-pre:  posts the question as a card, waits a bounded time for triage's verdict, then either denies the question
//           with triage's reason (a return or a hold) or lets the terminal dialog open. A deny reaches the agent before
//           the dialog, so it can ask again with a sharper question. Any failure, and a slow triage, lets the dialog
//           open: the first answer wins, and an answer on the card reaches the session through the channel.
// ask-post: the terminal answered first, so the card closes with that outcome.
// ask-cancel: the dialog ended without an answer: the person pressed Escape, the tool failed, the next prompt arrived, or
//           the session ended. The card closes unless the person answered it on the card.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, loadConfig } from '../../client.ts';
import { randomId } from '../../core/crypto.ts';
import type { AskQuestion, Card, CloseKind } from '../../core/types.ts';
import { homeDir } from '../../node/home.ts';
import { claudeSessionName } from './session-name.ts';
import { endStretch } from './card-stretch.ts';
import { herdrPlace } from '../herdr/place.ts';

/** How long ask-pre waits for triage's verdict. Its hook times out at 10 seconds, so the wait leaves time to post and
 * to print. A verdict that arrives later is delivered asynchronously, as before. */
const ASK_WAIT_MS = 8000;
const ASK_POLL_MS = 200;

/** The wait ask-pre uses: `ASK_WAIT_MS`, or a shorter value from `YOUR_ATTENTION_ASK_WAIT_MS` for a test. Never longer. */
function askWaitMs(): number {
  const asked = Number(process.env['YOUR_ATTENTION_ASK_WAIT_MS']);
  return Number.isFinite(asked) && asked >= 0 ? Math.min(asked, ASK_WAIT_MS) : ASK_WAIT_MS;
}

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { questions?: AskQuestion[] };
  tool_response?: unknown;
}

/** Why the question did not open as a dialog, for the deny the agent reads. A hold leaves the card in the person's
 * queue, so the reason names the dialog and not the card. */
export function denyReason(reason: string): string {
  const why = reason.trim() || 'it lacked the goal, the options you weighed, the evidence, or a recommendation';
  return `Triage stopped this question before the terminal dialog opened: ${why}. Ask again with the goal, the options you weighed, and your recommendation.`;
}

/** Triage's reason once the question is returned or held, or undefined while it is still unchecked or on its way to the
 * person. A return closes the card, a hold leaves it held, and either keeps it from the person. */
export function stoppedReason(card: Card, state: string): string | undefined {
  if (card.closed?.kind === 'returned') return denyReason(card.closed.outcome ?? '');
  if (state === 'held') return denyReason(card.triage?.reason ?? '');
  return undefined;
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  return raw;
}

/** Plain text for what the person picked in the terminal dialog. */
export function terminalOutcome(response: unknown): string {
  const answers = (response as { answers?: unknown } | undefined)?.answers ?? response;
  if (!answers || typeof answers !== 'object') return String(answers ?? '') || 'Answered in the terminal.';
  const parts = Object.entries(answers as Record<string, unknown>).map(([q, a]) => `${q} ${[a].flat().join(', ')}`);
  return parts.join(' · ') || 'Answered in the terminal.';
}

/** Poll the posted card until triage returns or holds it, it reaches the person, or `deadline` passes. It gives the deny
 * reason only for a return or a hold; anything else, including a read the inbox refuses, lets the dialog open. */
export async function awaitTriage(inbox: Client, id: string, deadline: number): Promise<string | undefined> {
  for (;;) {
    let seen: { card: Card; state: string };
    try {
      seen = await inbox.get(id);
    } catch {
      // No card to wait on, so there is nothing to deny: the dialog opens.
      return undefined;
    }
    const stopped = stoppedReason(seen.card, seen.state);
    if (stopped !== undefined) return stopped;
    // A card past triage is open (a pass), answered, or closed for another reason. The dialog belongs to the person now.
    if (seen.state !== 'in-triage') return undefined;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, Math.min(ASK_POLL_MS, deadline - Date.now())));
  }
}

export async function main(mode: string): Promise<void> {
  // The wait counts from the start, since the hook times out at 10 seconds including its own startup.
  const deadline = Date.now() + askWaitMs();
  const input = JSON.parse((await readStdin()) || '{}') as HookInput;
  const sid = input.session_id;
  const config = loadConfig();
  // A hook must never stop the session, so every failure exits quietly.
  // UserPromptSubmit and SessionEnd carry no tool name, and run ask-cancel for whatever is still pending.
  if (!sid || !config || (input.tool_name ?? (mode === 'ask-cancel' ? 'AskUserQuestion' : '')) !== 'AskUserQuestion') return;
  const inbox = new Client(config);
  // A prompt the person typed is activity, so it ends the stretch of inactivity and cancels the asks for a card. A
  // session that ends leaves no stretch behind, or a resumed session would be asked at once for a stretch long over.
  if (mode === 'ask-cancel' && (input.prompt !== undefined || input.hook_event_name === 'SessionEnd')) {
    try { endStretch(sid); } catch { /* a hook must never stop the session */ }
  }
  const pendingFile = path.join(homeDir(), 'claude', `${sid}.pending`);
  // The inbox refuses each close when the person already answered on the card.
  const closePending = async (kind: CloseKind, outcome: string): Promise<void> => {
    let id: string;
    try { id = fs.readFileSync(pendingFile, 'utf8').trim(); } catch { return; }
    fs.rmSync(pendingFile, { force: true });
    await inbox.close(id, kind, outcome, true).catch(() => {});
  };

  if (mode === 'ask-pre') {
    await closePending('resolved', 'The agent asked a new question in the terminal.');
    const questions = input.tool_input?.questions ?? [];
    const id = `ask-${randomId(4)}`;
    try {
      await inbox.post({
        id,
        agent: `claude:${sid}`,
        // Each question's text heads its own section, so the title joins their short labels instead of repeating one.
        title: questions.map((q) => q.header?.trim()).filter(Boolean).join(' · ') || 'A question from the agent',
        questions,
        dialog: true,
        priority: 'now',
        origin: { harness: 'claude-code', session: sid, name: claudeSessionName(sid), host: os.hostname(), cwd: process.cwd(), herdrPane: process.env['HERDR_PANE_ID'], ...(await herdrPlace(process.env['HERDR_PANE_ID'])) },
      });
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      fs.writeFileSync(pendingFile, id);
    } catch {}
    // Wait a bounded time for triage. A question it returns or holds is denied before the dialog opens, so the agent
    // reads the reason and asks again instead of the person seeing a weak question. Every other outcome, including a
    // slow, absent or broken triage, prints nothing and lets the dialog open.
    const stopped = await awaitTriage(inbox, id, deadline);
    if (stopped !== undefined) {
      // A deny fires PermissionDenied, which hooks.json maps to ask-cancel. That must not close the returned card as
      // resolved, so the pending file goes before the deny: ask-cancel then finds no card to close.
      fs.rmSync(pendingFile, { force: true });
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: stopped } })}\n`);
    }
    return;
  }

  if (mode === 'ask-post') await closePending('answered-in-terminal', terminalOutcome(input.tool_response));
  if (mode === 'ask-cancel') await closePending('resolved', 'The question was cancelled in the terminal.');
}
