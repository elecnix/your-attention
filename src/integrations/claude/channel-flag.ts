// Whether the Claude Code session that started this channel turned channel notifications on.
// Claude Code discards every channel notification of a session started without them, so the
// inbox tells the person when their session cannot receive an answer.
import { execFileSync } from 'node:child_process';

const FLAG = '--dangerously-load-development-channels';
const OURS = 'server:your-attention';

/** The command line of a process, or undefined when the platform cannot read one. */
export function parentCommandLine(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    // Windows has no ps, and a process that ended before the read leaves nothing to read.
    return undefined;
  }
}

/** Whether a command line enables this channel. `undefined` when there is no command line to read.
 * The flag takes its value as the next word or after `=`, and a comma joins several servers. */
export function devChannelEnabled(commandLine: string | undefined): boolean | undefined {
  if (commandLine === undefined) return undefined;
  const words = commandLine.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    const value = word === FLAG ? words[i + 1] : word.startsWith(`${FLAG}=`) ? word.slice(FLAG.length + 1) : undefined;
    if (value?.split(',').includes(OURS)) return true;
  }
  return false;
}
