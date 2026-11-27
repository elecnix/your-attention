// What a Bash command that the PreToolUse hook rewrote runs first: `eval "$(node secret-env.ts SOCKET TOKEN)"`. It asks
// the channel for the session's live grants with a token that works once, and prints them as `export` lines for the
// shell to evaluate. The values pass through a pipe into the shell's memory, and the shell's children get them in their
// environment. When the channel does not answer, it prints a line that fails, so the command does not run without them.
import { ask, exportLines } from './secret-socket.ts';

const [file, token] = process.argv.slice(2);
let reply: Record<string, unknown> | undefined;
try {
  reply = file && token ? await ask(file, { op: 'env', token }) : { error: 'no socket or token' };
} catch (e) {
  reply = { error: (e as Error).message };
}
process.stdout.write(`${exportLines(reply)}\n`);
