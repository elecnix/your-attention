// The Claude Code Stop hook: a session the person opted in is asked for a card when it stops with none open.
// Claude Code blocks the stop on exit code 2 and hands stderr to the model, so the request arrives as the reason to
// continue. The stop this hook itself causes carries stop_hook_active, which keeps the request from looping.
import { Client, loadConfig } from '../../client.ts';

interface StopInput {
  session_id?: string;
  stop_hook_active?: boolean;
}

/** The same sentence the pi extension sends, so both harnesses ask in one voice. */
export const NO_CARD = '[your-attention] This session has no open card. Post one with card_post that says what you are working on and what you need from the person.';

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  return raw;
}

export async function main(): Promise<void> {
  // The person opts in per session, so a background agent can run without a card.
  if (process.env['YOUR_ATTENTION_REQUIRE_CARD'] !== '1') return;
  let input: StopInput = {};
  try {
    input = JSON.parse((await readStdin()) || '{}') as StopInput;
  } catch {
    return;
  }
  // The stop this hook caused: asking again would loop.
  if (input.stop_hook_active) return;
  const config = loadConfig();
  if (!config) return;
  const session = input.session_id ?? process.env['CLAUDE_CODE_SESSION_ID'] ?? `pid-${process.ppid}`;
  const agent = `claude:${session}`;
  let open: boolean;
  try {
    open = (await new Client(config).list()).some((c) => c.card.agent === agent && c.state === 'open');
  } catch {
    // An inbox that cannot answer must never hold the session open.
    return;
  }
  if (open) return;
  process.stderr.write(`${NO_CARD}\n`);
  process.exitCode = 2;
}
