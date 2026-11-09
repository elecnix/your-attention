// Whether the Claude Code session that started this channel turned channel notifications on.
// Claude Code discards every channel notification of a session started without them, so the
// inbox tells the person when their session cannot receive an answer.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const FLAG = '--dangerously-load-development-channels';
const OURS = 'server:your-attention';

/** The words of a command line that can hold an option, up to the word where the prompt starts.
 * ps joins the arguments with spaces and loses their quoting, so a prompt reads as a run of words.
 * Claude Code takes its options first, and its prompt after `-p` or as the first word that opens no
 * dash, so the scan reaches no word of a prompt. */
/** The index of the word that closes the JSON value opened at `from`, or the last word when it never closes.
 * A brace inside a string is text, not nesting, so the scan skips the quoted runs of the value. */
function jsonEnd(words: readonly string[], from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < words.length; i++) {
    for (const ch of words[i] ?? '') {
      if (escaped) { escaped = false; continue; }
      if (inString) {
        if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth <= 0) return i;
    }
  }
  return words.length - 1;
}

export function psOptions(commandLine: string): string[] {
  const words = commandLine.trim().split(/\s+/);
  const options: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? '';
    if (!word.startsWith('-') || word === '--') break;
    options.push(word);
    // `-p` and `--print` take the prompt, and every later word belongs to it.
    if (word === '-p' || word === '--print') break;
    // An option's value is the next word when it opens no dash. The development-channels flag
    // reads its own value here too, so `--flag server:your-attention` counts.
    const next = words[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      // `ps` joins the arguments with spaces and loses their quoting, so a value that opens a brace is a JSON
      // argument that splits into several words. It ends where its braces close.
      if (next.startsWith('{')) {
        const end = jsonEnd(words, i + 1);
        options.push(words.slice(i + 1, end + 1).join(' '));
        i = end;
      } else {
        options.push(next);
        i++;
      }
    }
  }
  return options;
}

/** The argument vector of what Linux keeps in /proc/<pid>/cmdline. A process that rewrote its title,
 * as process.title does, leaves one word that holds the whole command line. */
export function procArgs(raw: string): string[] {
  const argv = raw.split('\0').filter((a) => a !== '');
  if (argv.length > 1) return argv;
  const line = argv[0];
  return line ? [line.split(/\s+/)[0] ?? '', ...psOptions(line)] : [];
}

/** The argument vector of a process, the program first. Linux keeps it byte exact, separated by
 * NUL, and elsewhere ps prints the command line it joined with spaces, widened so a long one keeps
 * its last word. Undefined when the platform offers no way to read one. */
export function parentArgs(pid: number): string[] | undefined {
  try {
    return procArgs(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch { /* no /proc, as on macOS and Windows */ }
  try {
    const line = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!line) return undefined;
    return [line.split(/\s+/)[0] ?? '', ...psOptions(line)];
  } catch {
    // Windows has no ps, and a process that ended before the read leaves nothing to read.
    return undefined;
  }
}

/** Whether an argument vector enables this channel. `undefined` when there is no vector to read. */
export function devChannelEnabled(argv: readonly string[] | undefined): boolean | undefined {
  if (argv === undefined) return undefined;
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] ?? '';
    const value = word === FLAG ? argv[i + 1] : word.startsWith(`${FLAG}=`) ? word.slice(FLAG.length + 1) : undefined;
    if (value?.split(',').includes(OURS)) return true;
    // `-p` and `--print` take the prompt as their own value, so that word is never a flag, and the words after it are
    // options again, since the CLI still reads them as such.
    if (word === '-p' || word === '--print') i++;
  }
  return false;
}
