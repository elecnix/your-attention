// Claude Code hooks for AskUserQuestion.
// ask-pre:  posts the question as a card and returns at once, so the terminal
//           dialog opens too. The first answer wins: an answer on the card
//           reaches the session through the channel.
// ask-post: the terminal answered first, so the card closes with that outcome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, loadConfig } from '../../client.ts';
import { randomId } from '../../core/crypto.ts';
import type { AskQuestion } from '../../core/types.ts';
import { homeDir } from '../../node/home.ts';

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: { questions?: AskQuestion[] };
  tool_response?: unknown;
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

export async function main(mode: string): Promise<void> {
  const input = JSON.parse((await readStdin()) || '{}') as HookInput;
  const sid = input.session_id;
  const config = loadConfig();
  // A hook must never stop the session, so every failure exits quietly.
  if (input.tool_name !== 'AskUserQuestion' || !sid || !config) return;
  const inbox = new Client(config);
  const pendingFile = path.join(homeDir(), 'claude', `${sid}.pending`);

  if (mode === 'ask-pre') {
    const questions = input.tool_input?.questions ?? [];
    const id = `ask-${randomId(4)}`;
    try {
      await inbox.post({
        id,
        agent: `claude:${sid}`,
        title: questions[0]?.question ?? 'A question from the agent',
        questions,
        priority: 'now',
        origin: { harness: 'claude-code', session: sid, host: os.hostname(), cwd: process.cwd(), herdrPane: process.env['HERDR_PANE_ID'] },
      });
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      fs.writeFileSync(pendingFile, id);
    } catch {}
    return;
  }

  if (mode === 'ask-post') {
    let id: string;
    try { id = fs.readFileSync(pendingFile, 'utf8').trim(); } catch { return; }
    fs.rmSync(pendingFile, { force: true });
    // The inbox refuses this when the person already answered on the card.
    await inbox.close(id, 'answered-in-terminal', terminalOutcome(input.tool_response), true).catch(() => {});
  }
}
