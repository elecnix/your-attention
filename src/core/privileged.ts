// Privileged actions: a command that needs a password, such as one run with sudo, which the person approves on a card
// and the inbox runs. The agent never holds the password. The page seals it to the broker's key, which only the inbox
// holds, in memory, and the broker opens it inside the owner's answer, runs the one command the card shows, and keeps
// only what the command printed, with the password masked. SPEC.md#privileged-actions holds the contract.
import type { Sealed } from './types.ts';

/** What a runner reports about one run. */
export interface RunResult {
  /** The exit code, or null when a signal ended the command, such as the time limit. */
  exitCode: number | null;
  /** What the command printed, stdout and stderr in the order they came, cut to its last MAX_OUTPUT_CHARS. */
  output: string;
  /** Why the command ended early, such as the time limit. */
  ended?: string;
}

/** Runs a command on one machine with a password on its standard input. The laptop inbox runs one on its own machine;
 * a remote one would run it over ssh. */
export interface PrivilegedRunner {
  /** The machine the runner runs commands on, as a card names it. */
  readonly machine: string;
  /** Run `command` and write `password` and a newline to its standard input, then close it. The password stays an
   * argument of this call: a runner never writes it to a file, an environment variable, an argument list or a log. */
  run(command: string, password: string): Promise<RunResult>;
}

/** What the inbox stores for a privileged action field once the command ran, and what the agent receives. */
export interface PrivilegedRun {
  command: string;
  machine: string;
  exitCode: number | null;
  output: string;
  ended?: string;
  /** The audit id of the run. */
  audit: string;
  ranAt: number;
}

/** One line of the audit: who approved which command on which machine, and how it ended. */
export interface AuditEntry {
  id: string;
  card: string;
  field: string;
  agent: string;
  command: string;
  machine: string;
  /** The name of the owner token that sent the answer. */
  approvedBy: string;
  at: number;
  exitCode: number | null;
  ended?: string;
}

/** The broker's public key as `GET /v1/privileged/key` answers it, with the machine its runner serves. */
export interface BrokerKey {
  publicKey: JsonWebKey;
  machine: string;
}

/** The plain text the page seals: the command it showed, and the password typed for it. */
export interface PrivilegedSeal {
  command: string;
  password: string;
}

export type { Sealed };

/** The output the inbox keeps of a run, from its end. */
export const MAX_OUTPUT_CHARS = 64 * 1024;
/** The longest command a card may show. */
export const MAX_COMMAND_CHARS = 4000;
/** How long a run may take before the runner stops it. */
export const RUN_TIMEOUT_MS = 2 * 60_000;
/** What replaces the password in what the command printed. */
export const PASSWORD_MASK = '[password]';

/** `text` with every occurrence of `password` replaced by PASSWORD_MASK. */
export function maskPassword(text: string, password: string): string {
  return password ? text.split(password).join(PASSWORD_MASK) : text;
}

/** A character as a reader sees it in a message: printable characters as they are, others as an escape. */
function shown(c: string | undefined): string {
  if (c === undefined) return 'the end of the command';
  return `"${JSON.stringify(c).slice(1, -1)}"`;
}

/** Why the approved command differs from the card's, naming the first character that differs, or undefined when they
 * are the same. */
export function commandDifference(card: string, approved: string): string | undefined {
  if (card === approved) return undefined;
  let i = 0;
  while (i < card.length && i < approved.length && card[i] === approved[i]) i++;
  const around = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
  return `the approved command differs from the card's at character ${i + 1}: the card has ${shown(card[i])} and the approval has ${shown(approved[i])}, in ${around(card)} and ${around(approved)}`;
}

/** Read what the page sealed. Undefined when it is not a command and a password as text. */
export function readSeal(plain: string): PrivilegedSeal | undefined {
  let v: unknown;
  try { v = JSON.parse(plain); } catch { return undefined; }
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  return typeof r['command'] === 'string' && typeof r['password'] === 'string' ? { command: r['command'], password: r['password'] } : undefined;
}

/** A runner that runs nothing and answers the command it would run, for tests and for a dry run. */
export function dryRunner(machine: string): PrivilegedRunner {
  return { machine, run: async (command) => ({ exitCode: 0, output: `dry run: would run on ${machine}: ${command}\n` }) };
}
