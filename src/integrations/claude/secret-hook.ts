// The Claude Code hooks of secret delivery, on the Bash tool.
// secret-pre:  PreToolUse. When the session's channel holds a live grant, it rewrites the command so that the shell
//              first reads the variables from the channel's socket, once, with a one-time token, and then runs it.
// secret-post: PostToolUse. It masks each value the session received in the command's output, as [secret NAME],
//              before the model reads it.
// A session whose channel has no socket, or holds no grant, gets no output from either hook, so Claude Code runs the
// command as the model wrote it.
import fs from 'node:fs';
import path from 'node:path';
import { ask, rewrite, socketPath } from './secret-socket.ts';

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
  if (!fs.existsSync(file)) return undefined;
  if (mode === 'secret-pre') {
    const command = input.tool_input?.['command'];
    if (typeof command !== 'string') return undefined;
    const reply = await ask(file, { op: 'token' });
    const token = reply?.['token'];
    if (typeof token !== 'string') return undefined;
    // updatedInput replaces the whole input, so the other fields go back as they came. No permission decision: the
    // person's rules and mode judge the rewritten command as they would any other.
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: rewrite(command, file, token, READER) } } };
  }
  if (input.tool_response === undefined) return undefined;
  const reply = await ask(file, { op: 'mask', value: input.tool_response });
  if (!reply || !('value' in reply) || JSON.stringify(reply['value']) === JSON.stringify(input.tool_response)) return undefined;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: reply['value'] } };
}

export async function main(mode: string): Promise<void> {
  if (mode !== 'secret-pre' && mode !== 'secret-post') return;
  let input: HookInput;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) as HookInput; } catch { return; }
  const out = await handle(mode, input);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}
