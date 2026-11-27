// pi's bash tool, rebuilt with pi's own createBashTool so that each command it spawns gets the session's live grants
// in its environment. The value goes into the environment of the spawned shell only: never into argv, where `ps` shows
// it, and never into this process's own environment, which every later child would inherit. The output is masked as
// it streams, before pi shows it, saves a long one to a file, or hands it to the model.
import type { SecretRequests } from '../secrets.ts';

/** The parts of pi's bash tool this module uses. */
export interface BashOperations {
  exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }>;
}
interface SpawnContext { command: string; cwd: string; env: NodeJS.ProcessEnv }
export interface BashTool {
  name: string;
  execute(id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown): Promise<unknown>;
}
/** What the extension takes from `@earendil-works/pi-coding-agent`, which pi maps for its extensions. */
export interface PiTools {
  createBashTool(cwd: string, options: { spawnHook: (ctx: SpawnContext) => SpawnContext; operations: BashOperations }): BashTool;
  createLocalBashOperations(): BashOperations;
}

/** pi's tools module, from inside pi. The name sits in a variable so this package needs no copy of pi to build. */
export async function loadPiTools(): Promise<PiTools | undefined> {
  const name = '@earendil-works/pi-coding-agent';
  try {
    const mod = (await import(name)) as Partial<PiTools>;
    return typeof mod.createBashTool === 'function' && typeof mod.createLocalBashOperations === 'function' ? (mod as PiTools) : undefined;
  } catch {
    return undefined;
  }
}

/** The bash tool for `agent`: pi's own, with the live grants added to each command's environment and its output masked. */
export function secretBash(pi: PiTools, cwd: string, secrets: SecretRequests, agent: () => string): BashTool {
  const local = pi.createLocalBashOperations();
  const operations: BashOperations = {
    async exec(command, dir, options) {
      const mask = secrets.stream();
      const decoder = new TextDecoder();
      const emit = (text: string): void => { if (text) options.onData(Buffer.from(text)); };
      const result = await local.exec(command, dir, { ...options, onData: (data) => emit(mask.push(decoder.decode(data, { stream: true }))) });
      emit(mask.push(decoder.decode()) + mask.end());
      return result;
    },
  };
  return pi.createBashTool(cwd, {
    // A revoke or an expiry takes effect here, at the start of the next command.
    spawnHook: ({ command, cwd: dir, env }) => ({ command, cwd: dir, env: { ...env, ...secrets.env(agent()) } }),
    operations,
  });
}
