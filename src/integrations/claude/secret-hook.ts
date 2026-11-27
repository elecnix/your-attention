// The Claude Code hooks of secret delivery, on the Bash tool.
// secret-pre:  PreToolUse. When the session's channel holds a live grant, it rewrites the command so that the shell
//              first reads the variables from the channel's socket, once, with a one-time token, and then runs it.
// secret-post: PostToolUse. It masks each value the session received in the command's output, as [secret NAME],
//              before the model reads it. A rewritten command ends with status 0 and reports a failure as text,
//              because Claude Code runs PostToolUse only on success. When the channel can't mask, the hook withholds
//              the output of a rewritten command.
// A session whose channel has no socket, or holds no grant, gets no output from either hook, so Claude Code runs the
// command as the model wrote it.
import fs from 'node:fs';
import path from 'node:path';
import { ask, readerPrefix, rewrite, socketPath } from './secret-socket.ts';

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

/** The command that reads the variables: this Node, on the reader script beside this file. */
export const READER = [process.execPath, path.join(import.meta.dirname, 'secret-env.ts')];

/** What the hook prints for `input`, or undefined to leave the call as it is. */
export async function handle(mode: 'secret-pre' | 'secret-post', input: HookInput, env: NodeJS.ProcessEnv = process.env): Promise<object | undefined> {
  if (input.tool_name !== 'Bash' || !input.session_id) return undefined;
  const file = socketPath(input.session_id, env);
  if (mode === 'secret-post') return post(file, input);
  if (!fs.existsSync(file)) return undefined;
  const command = input.tool_input?.['command'];
  if (typeof command !== 'string') return undefined;
  // The model reads a background command's output through another tool, which secret-post doesn't see, so a
  // background command runs as written, without the variables.
  if (input.tool_input?.['run_in_background'] === true) return undefined;
  const reply = await ask(file, { op: 'token' });
  const token = reply?.['token'];
  if (typeof token !== 'string') return undefined;
  // updatedInput replaces the whole input, so the other fields go back as they came. No permission decision: the
  // person's rules and mode judge the rewritten command as they would any other.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: rewrite(command, file, token, READER) } } };
}

/** What the model reads in place of an output the channel could not mask. */
export const WITHHELD = 'your-attention withheld this output: the channel that masks the secrets of this session did not answer.';

/** secret-post: mask the output of a command. A command the hook rewrote had the secrets in its environment, so when
 * the channel can't mask its output, the hook withholds the output rather than let a value through. */
async function post(file: string, input: HookInput): Promise<object | undefined> {
  if (input.tool_response === undefined) return undefined;
  const command = input.tool_input?.['command'];
  const rewritten = typeof command === 'string' && command.startsWith(readerPrefix(READER));
  const reply = fs.existsSync(file) ? await ask(file, { op: 'mask', value: input.tool_response }) : undefined;
  const masked = reply && 'value' in reply ? reply['value'] : rewritten ? withhold(input.tool_response) : undefined;
  if (masked === undefined || JSON.stringify(masked) === JSON.stringify(input.tool_response)) return undefined;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: masked } };
}

/** The output with its text replaced: stdout says why, and every other string is empty. */
function withhold(output: unknown): unknown {
  if (typeof output === 'string') return WITHHELD;
  if (!output || typeof output !== 'object') return output;
  return Object.fromEntries(Object.entries(output).map(([k, v]) => [k, typeof v === 'string' ? (k === 'stdout' ? WITHHELD : '') : v]));
}

export async function main(mode: string): Promise<void> {
  if (mode !== 'secret-pre' && mode !== 'secret-post') return;
  let input: HookInput;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) as HookInput; } catch { return; }
  const out = await handle(mode, input);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}
