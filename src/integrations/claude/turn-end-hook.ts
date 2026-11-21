// The Claude Code Stop hook: it records that the session's turn ended, which starts a stretch of inactivity.
// It never blocks the stop. The channel beside the session reads the stretch and, when the rule covers the session and
// it holds no open card, asks for one at the minutes the rule names, counted from this moment.
import { loadConfig } from '../../client.ts';
import { afterTurn } from '../card-asks.ts';
import { fileStore } from './card-stretch.ts';

interface StopInput {
  session_id?: string;
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  return raw;
}

export async function main(): Promise<void> {
  let input: StopInput = {};
  try {
    input = JSON.parse((await readStdin()) || '{}') as StopInput;
  } catch {
    return;
  }
  // Without an inbox there is no channel to ask, so there is nothing to time.
  if (!loadConfig()) return;
  const session = input.session_id ?? process.env['CLAUDE_CODE_SESSION_ID'] ?? `pid-${process.ppid}`;
  const store = fileStore(session);
  try {
    // The turn an ask started keeps its stretch, so the next ask still lands at its minute; any other turn starts one.
    store.save(afterTurn(store.load(), Date.now()));
  } catch {
    // A hook must never stop the session.
  }
}
