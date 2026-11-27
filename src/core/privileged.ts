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

/** Runs a command on one machine with a password on its standard input. Your own inbox runs one on the machine it runs on,
 * and an ssh runner runs one on the machine it reaches. Each runner serves exactly one machine name, and the inbox picks
 * the runner by the name the card gives: no runner stands in for another. */
export interface PrivilegedRunner {
  /** The machine the runner runs commands on, as a card names it. */
  readonly machine: string;
  /** Whether a run needs the person's password, the default, or only their approval. */
  readonly sudo?: SudoMode;
  /** Why this runner refuses a command before anything runs, such as one its sudoers rule doesn't cover, or undefined. */
  refuse?(command: string): string | undefined;
  /** Run `command` and write `password` and a newline to its standard input, then close it. An approval runner gets an
   * empty password and writes nothing. The password stays an argument of this call: a runner never writes it to a file,
   * an environment variable, an argument list or a log. */
  run(command: string, password: string, ctx: RunContext): Promise<RunResult>;
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

/** The broker's public key as `GET /v1/privileged/key` answers it, with the machines its runners serve. `machine` is
 * the first of them, the inbox's own machine. */
export interface BrokerKey {
  publicKey: JsonWebKey;
  machine: string;
  machines: { name: string; sudo: SudoMode }[];
}

/** The plain text the page seals: the command and the machine it showed, and the password typed for it. On a machine
 * that takes an approval, the password is empty and `approve` is true. */
export interface PrivilegedSeal {
  command: string;
  machine: string;
  password: string;
  approve?: boolean;
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

/** Why the machine the person approved differs from the card's, or undefined when they are the same. A revision that
 * moves the card to another machine after the page drew it must not carry the password there. */
export function machineDifference(card: string, approved: string): string | undefined {
  return card === approved ? undefined : `the card now names the machine ${JSON.stringify(card)}, and the person approved the command on ${JSON.stringify(approved)}`;
}

/** Read what the page sealed. Undefined when it is not a command and a password as text. */
export function readSeal(plain: string): PrivilegedSeal | undefined {
  let v: unknown;
  try { v = JSON.parse(plain); } catch { return undefined; }
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r['command'] !== 'string' || typeof r['machine'] !== 'string' || typeof r['password'] !== 'string') return undefined;
  return { command: r['command'], machine: r['machine'], password: r['password'], ...(r['approve'] === true ? { approve: true } : {}) };
}

/** A runner that runs nothing and answers the command it would run, for tests and for a dry run. */
export function dryRunner(machine: string): PrivilegedRunner {
  return { machine, run: async (command) => ({ exitCode: 0, output: `dry run: would run on ${machine}: ${command}\n` }) };
}

// ---- privileged actions on another machine ----

/** How a machine takes a privileged action: with the person's password for `sudo -S`, or with an approval alone, where
 * the sudoers rule lets the commands run without a password. */
export type SudoMode = 'password' | 'approval';

/** What a run tells the runner besides the command: the audit line the far side writes before it runs anything. */
export interface RunContext {
  /** The audit id, which the inbox's audit, the answer and the far side's system log all carry. */
  audit: string;
  card: string;
  field: string;
  /** The name of the owner token that sent the answer. */
  approvedBy: string;
}

/** A machine the broker reaches over ssh, one line of machines.jsonl. */
export interface RemoteMachine {
  /** The name a card gives as its machine. */
  name: string;
  /** The ssh destination host, as `ssh` and its config resolve it. */
  host: string;
  /** The account on the far side that ssh logs in as, and that the sudoers rule names. */
  user: string;
  port?: number;
  /** The short name the far side reports with `uname -n`, which it checks before it runs anything. `name` by default. */
  hostname?: string;
  sudo: SudoMode;
  /** The commands a person may approve on this machine, each as a card shows it. The sudoers rule lists the same ones. */
  allow: string[];
}

/** The characters a shell treats as syntax when they stand outside quotes. The broker runs no shell syntax, so a command
 * holds them only inside quotes. */
const SHELL_SYNTAX = new Set([...'|&;<>()$`*?[]{}#~!']);

/** The words of a command as `sh` would split it, for a command that uses quotes and backslashes and no other shell
 * syntax: no variable, substitution, glob, redirection, pipe or list. It throws with a sentence that names what the
 * broker will not run. Single quotes keep everything as it is; double quotes keep everything but `\"` and `\\`, and
 * refuse `$` and a backquote, which a shell would expand there. */
export function parseCommand(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  const at = (i: number) => `at character ${i + 1}`;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === ' ' || c === '\t') { if (word !== undefined) words.push(word); word = undefined; continue; }
    if (c === '\n' || c === '\r') throw new Error(`the command holds a line break ${at(i)}: give it on one line`);
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error(`the single quote ${at(i)} is never closed`);
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      let text = '';
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!;
        if (d === '$' || d === '`') throw new Error(`the ${d} ${at(j)} sits in double quotes, where a shell would expand it: put that text in single quotes`);
        if (d === '\\' && (command[j + 1] === '"' || command[j + 1] === '\\')) { text += command[++j]; continue; }
        text += d;
      }
      if (j >= command.length) throw new Error(`the double quote ${at(i)} is never closed`);
      word = (word ?? '') + text;
      i = j;
      continue;
    }
    if (c === '\\') {
      const next = command[i + 1];
      if (next === undefined) throw new Error('the command ends with a backslash');
      if (next === '\n') throw new Error(`the command holds a line break ${at(i + 1)}: give it on one line`);
      word = (word ?? '') + next;
      i++;
      continue;
    }
    if (SHELL_SYNTAX.has(c)) throw new Error(`the ${c} ${at(i)} is shell syntax, and the broker runs no shell: put it in single quotes if it is part of an argument`);
    word = (word ?? '') + c;
  }
  if (word !== undefined) words.push(word);
  if (!words.length) throw new Error('the command is empty');
  return words;
}

/** One word for a POSIX shell, in single quotes, so the far side's shell reads it back exactly. */
export function shellQuote(word: string): string {
  return `'${word.split("'").join(`'\\''`)}'`;
}

const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A short host name, as the far side compares it: `uname -n` up to its first dot. */
const SHORT_HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,252}$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/** Why sudoers cannot list this command exactly, or undefined when it can. sudo compares the arguments as one string
 * joined by spaces, so an empty argument, or one that holds whitespace, has no exact rule: `'a b'` and `a b` would match
 * the same line. */
function sudoersGap(words: string[]): string | undefined {
  if (!words[0]!.startsWith('/')) return `${JSON.stringify(words[0])} is not an absolute path, which sudoers needs and which keeps PATH on either machine out of it`;
  // sudoers matches the path as a pattern, so a * or a [ there would allow more commands than this one.
  if (!/^[A-Za-z0-9._/+-]+$/.test(words[0]!)) return `the path ${JSON.stringify(words[0])} holds a character other than letters, digits and . _ / + -, which sudoers would read as a pattern or as syntax`;
  const bad = words.slice(1).find((w) => w === '' || /\s/.test(w));
  return bad === undefined ? undefined : `the argument ${JSON.stringify(bad)} is empty or holds whitespace, which a sudoers rule cannot tell apart from separate arguments`;
}

/** A machine from one parsed line of machines.jsonl, or the sentence that says why the line is not one. */
export function readMachine(v: unknown): RemoteMachine | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'a machine is a JSON object';
  const r = v as Record<string, unknown>;
  const name = r['name'];
  if (typeof name !== 'string' || !MACHINE_NAME.test(name)) return 'name must be a machine name such as web1';
  const host = r['host'] ?? name;
  if (typeof host !== 'string' || !HOST.test(host)) return `${name}: host must be an ssh host that doesn't start with -`;
  const user = r['user'];
  if (typeof user !== 'string' || !USER.test(user)) return `${name}: user must name the account ssh logs in as`;
  const port = r['port'];
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return `${name}: port must be a whole number from 1 to 65535`;
  const hostname = r['hostname'] ?? name.split('.')[0];
  if (typeof hostname !== 'string' || !SHORT_HOSTNAME.test(hostname)) return `${name}: hostname must be the short name uname -n prints on that machine, up to its first dot`;
  const sudo = r['sudo'];
  if (sudo !== 'password' && sudo !== 'approval') return `${name}: sudo must be "password", for a machine whose sudo asks for one, or "approval", for one whose sudoers rule needs none`;
  const allow = r['allow'];
  if (!Array.isArray(allow) || !allow.length || !allow.every((a) => typeof a === 'string')) return `${name}: allow must list at least one command, as a card shows it`;
  for (const a of allow as string[]) {
    let words: string[];
    try { words = parseCommand(a); } catch (e) { return `${name}: the allowed command ${JSON.stringify(a)} doesn't parse: ${(e as Error).message}`; }
    const gap = sudoersGap(words);
    if (gap) return `${name}: the allowed command ${JSON.stringify(a)}: ${gap}`;
  }
  return { name, host, user, ...(port === undefined ? {} : { port }), hostname, sudo, allow: allow as string[] };
}

/** Why the machine's rule doesn't cover the command, or undefined when one allowed command has exactly its words. */
export function uncovered(machine: RemoteMachine, command: string): string | undefined {
  let words: string[];
  try { words = parseCommand(command); } catch (e) { return `the broker cannot run it on ${machine.name}: ${(e as Error).message}`; }
  const same = (a: string[]) => a.length === words.length && a.every((w, i) => w === words[i]);
  if (machine.allow.some((a) => same(parseCommand(a)))) return undefined;
  return `the sudoers rule of ${machine.name} doesn't cover it, so the broker refuses it before anything runs. ${machine.name} allows ${machine.allow.map((a) => JSON.stringify(a)).join(', ')}. Add the command to allow in machines.jsonl, and to the rule that \`your-attention machines sudoers ${machine.name}\` prints`;
}

/** The audit line the far side writes to its system log: printable text with no line break. */
export function auditLine(machine: string, command: string, ctx: RunContext): string {
  const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return flat(`audit ${ctx.audit}: ${ctx.approvedBy} approved card ${ctx.card} field ${ctx.field} to run on ${machine}: ${command}`);
}

/** The text the far side prints once its audit line is in the system log, just before sudo starts. */
export const startedMark = (machine: string, audit: string): string => `your-attention: audit ${audit} is in the system log of ${machine}, and sudo starts now`;

/** The exit code of the far side when it is not the machine the card names. */
export const WRONG_MACHINE_EXIT = 97;
/** The exit code of the far side when its system log took no audit line. */
export const NO_AUDIT_EXIT = 98;

/** The one line the far side's login shell runs. It checks that it is the machine the card names, writes the audit line
 * to the system log, and replaces itself with sudo, which runs the command's words without a shell. The password is in
 * none of it: sudo -S reads it from standard input. */
export function remoteCommand(machine: RemoteMachine, command: string, ctx: RunContext): string {
  const words = parseCommand(command);
  const expected = shellQuote(machine.hostname ?? machine.name);
  const sudo = machine.sudo === 'password' ? "sudo -k -S -p ''" : 'sudo -k -n';
  return [
    `h=$(uname -n); h=\${h%%.*}; if [ "$h" != ${expected} ]; then echo "your-attention: this machine is $h, not "${expected}", so nothing ran" >&2; exit ${WRONG_MACHINE_EXIT}; fi`,
    `logger -t your-attention -p authpriv.notice -- ${shellQuote(auditLine(machine.name, command, ctx))} || { echo 'your-attention: the system log took no audit line, so nothing ran' >&2; exit ${NO_AUDIT_EXIT}; }`,
    `echo ${shellQuote(startedMark(machine.name, ctx.audit))} >&2`,
    `exec ${sudo} -- ${words.map(shellQuote).join(' ')}`,
  ].join('; ');
}

/** A word as sudoers reads it in a command's arguments: a backslash before each character sudoers treats as syntax or
 * as a wildcard. */
function sudoersWord(word: string): string {
  return word.replace(/[\\,:=()!*?[\]#"]/g, (c) => `\\${c}`);
}

/** The sudoers rule a machine needs, for /etc/sudoers.d/your-attention on that machine: the commands a person may
 * approve, run as root, with a password for a "password" machine and without one for an "approval" machine. */
export function sudoersRule(machine: RemoteMachine): string {
  const alias = `YOUR_ATTENTION_${machine.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const commands = machine.allow.map((a) => parseCommand(a).map((w, i) => (i === 0 ? w : sudoersWord(w))).join(' '));
  return [
    `# The commands a person may approve on ${machine.name} from a your-attention card. The broker refuses any other.`,
    `# Install on ${machine.name} with: sudo visudo -f /etc/sudoers.d/your-attention`,
    `Cmnd_Alias ${alias} = ${commands.join(', \\\n    ')}`,
    `${machine.user} ALL=(root) ${machine.sudo === 'approval' ? 'NOPASSWD: ' : ''}${alias}`,
    '',
  ].join('\n');
}
