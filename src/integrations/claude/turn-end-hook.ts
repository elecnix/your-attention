// The Claude Code Stop hook: a session the person opted in is asked for a card when it stops with none open.
// Claude Code blocks the stop on exit code 2 and hands stderr to the model, so the request arrives as the reason to
// continue. The stop this hook itself causes carries stop_hook_active, which keeps the request from looping.
import fs from 'node:fs';
import path from 'node:path';
import { Client, loadConfig } from '../../client.ts';
import { homeDir } from '../../node/home.ts';

interface StopInput {
  session_id?: string;
  stop_hook_active?: boolean;
}

/** How many times one stretch without a card is asked about. The person chose three. */
export const CARD_REQUESTS = 3;

/** Where one session's asks are counted. Each stop runs as its own process, so the count needs a file. */
export function asksFile(session: string): string {
  return path.join(homeDir(), 'claude', `${session}.card-asks`);
}

/** Forget the asks of one session: the person spoke, an answer arrived, or a card of its own is open. */
export function resetAsks(session: string): void {
  fs.rmSync(asksFile(session), { force: true });
}

function readAsks(session: string): number {
  try {
    const n = Number(fs.readFileSync(asksFile(session), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeAsks(session: string, n: number): void {
  const file = asksFile(session);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, String(n), { mode: 0o600 });
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
  // A card of its own is what the request asks for, so that resets the count.
  if (open) {
    resetAsks(session);
    return;
  }
  // Three asks is the cap: a session that cannot post a card is left alone rather than asked forever.
  const asked = readAsks(session);
  if (asked >= CARD_REQUESTS) return;
  writeAsks(session, asked + 1);
  process.stderr.write(`${NO_CARD}\n`);
  process.exitCode = 2;
}
