// The folder of this user's secrets sockets, in plain JavaScript so the plugin runner can check it before it starts the
// CLI. src/integrations/claude/secret-socket.ts computes the same folder, and a unit test keeps the two in step.
import os from 'node:os';
import path from 'node:path';

/** The runtime folder when the system has one, the temp folder otherwise, with a folder per user inside. */
export function secretsDir(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR;
  const base = runtime ? runtime : os.tmpdir();
  return path.join(base, `your-attention-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);
}
