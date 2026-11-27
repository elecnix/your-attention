// The Claude Code side of secret delivery. The channel process holds the session's grants in memory and answers on a
// Unix socket that only this user can open: a socket of mode 0600 in a folder of mode 0700. The PreToolUse hook asks it
// for a one-time token and rewrites the Bash command so that the shell first reads the variables with that token, once,
// and exports them. The PostToolUse hook asks it to mask the command's output before the model reads it. The value
// crosses the socket into the shell's memory and never touches a file, argv or the hook's output.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { SecretRequests } from '../secrets.ts';

/** How long a token waits for the command it was made for. The command starts after the hook answers, and after the
 * person answers a permission prompt when one shows, which can take a while. */
export const TOKEN_MS = 30 * 60_000;
/** The most tokens waiting at once. A command the person refuses leaves its token unused until it expires. */
export const MAX_TOKENS = 256;

/** The folder of this user's sockets: the runtime folder when the system has one, the temp folder otherwise. */
export function socketDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env['XDG_RUNTIME_DIR'];
  const base = runtime ? runtime : os.tmpdir();
  return path.join(base, `your-attention-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);
}

/** The socket of the channel of `session`. A hash keeps the path under the 104 bytes macOS allows a socket path. */
export function socketPath(session: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(socketDir(env), `${crypto.createHash('sha256').update(session).digest('hex').slice(0, 16)}.sock`);
}

/** Make the folder with mode 0700, or check that the one already there belongs to this user and nobody else can enter. */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

type Request = { op: 'token' } | { op: 'env'; token: string } | { op: 'mask'; value: unknown };

/** Serve the grants of `agent` on the socket of `session`, until `close`. */
export async function serveSecrets(secrets: SecretRequests, agent: string, session: string, env: NodeJS.ProcessEnv = process.env): Promise<{ path: string; close: () => void }> {
  const file = socketPath(session, env);
  // macOS refuses a socket path past 104 bytes with a bare EINVAL, so the reason is said here.
  if (Buffer.byteLength(file) > 103) throw new Error(`the socket path ${file} is longer than the 103 bytes a socket path may take; set XDG_RUNTIME_DIR to a shorter folder`);
  privateDir(path.dirname(file));
  // A socket left by a channel of the same session that crashed: nothing answers on it any more.
  fs.rmSync(file, { force: true });
  const tokens = new Map<string, number>();
  const answer = (req: Request): unknown => {
    const now = Date.now();
    for (const [t, until] of tokens) if (until <= now) tokens.delete(t);
    if (req.op === 'token') {
      if (!secrets.holds(agent)) return {};
      const token = crypto.randomBytes(16).toString('hex');
      // The oldest token goes first when too many wait: a Map keeps insertion order.
      while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value as string);
      tokens.set(token, now + TOKEN_MS);
      return { token };
    }
    if (req.op === 'env') {
      // A token works once: the shell of one command reads the variables, and nobody can read them again with it.
      if (!tokens.delete(req.token)) return { error: 'this token is unknown, used or expired' };
      return { env: secrets.env(agent) };
    }
    if (req.op === 'mask') return { value: secrets.maskDeep(req.value) };
    return { error: 'unknown request' };
  };
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let reply: unknown;
      try { reply = answer(JSON.parse(buf.slice(0, nl)) as Request); } catch (e) { reply = { error: (e as Error).message }; }
      sock.end(`${JSON.stringify(reply)}\n`);
    });
    sock.on('error', () => {});
  });
  const old = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(file, () => resolve()); });
  } finally {
    process.umask(old);
  }
  fs.chmodSync(file, 0o600);
  server.unref();
  // A later channel of the same session, such as a resume in another terminal, replaces this socket with its own, so
  // close removes the file only while it is still the one this server made.
  // The inode alone is not enough: a file system hands a freed inode number to the next file it makes.
  const identity = (): string => { const st = fs.statSync(file, { bigint: true }); return `${st.ino}:${st.ctimeNs}`; };
  const mine = identity();
  // libuv removes the socket's path when the server closes, whichever socket the path holds by then. So once another
  // channel's socket sits there, close leaves the server open: its handle ends with this process, which exits next.
  const close = (): void => {
    let ours = false;
    try { ours = identity() === mine; } catch { /* already gone */ }
    if (ours) server.close();
  };
  return { path: file, close };
}

/** Ask the channel at `file` one question. Undefined when no channel answers there. */
export function ask(file: string, req: Request, timeoutMs = 2000): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const sock = net.createConnection(file);
    let buf = '';
    const done = (v: Record<string, unknown> | undefined): void => { clearTimeout(timer); sock.destroy(); resolve(v); };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (chunk: string) => { buf += chunk; });
    sock.on('end', () => { try { done(JSON.parse(buf) as Record<string, unknown>); } catch { done(undefined); } });
    sock.on('error', () => done(undefined));
  });
}

/** A word the shells read as one literal word. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The lines the shell evaluates for the channel's reply to an `env` request: an `export` per variable, or a line
 * that fails with the reason, so the command does not run without its variables. */
export function exportLines(reply: Record<string, unknown> | undefined): string {
  const env = reply?.['env'];
  if (!env || typeof env !== 'object') {
    const why = typeof reply?.['error'] === 'string' ? reply['error'] : 'the Claude Code channel did not answer';
    return `echo ${shellQuote(`your-attention: the secrets of this session did not reach the command: ${why}`)} >&2; false`;
  }
  const names = Object.keys(env).filter((n) => NAME.test(n));
  return [...names.map((n) => `export ${n}=${shellQuote(String((env as Record<string, unknown>)[n]))}`), 'true'].join('\n');
}

/** The command the hook runs instead of `command`: read the variables once with `token`, export them, then run it.
 * The original command keeps the same shell, so a `cd` or a function it defines behaves as before. */
export function rewrite(command: string, file: string, token: string, reader: string[]): string {
  // Claude Code runs only PostToolUse hooks on a command that exits 0, and a PostToolUseFailure hook can't change the
  // error text. So the command reports a failure as text and ends with status 0, which lets secret-post mask it.
  return `${readerPrefix(reader)} ${shellQuote(file)} ${shellQuote(token)})" && {\n${command}\n}\n`
    + `__ya_status=$?; if [ "$__ya_status" -ne 0 ]; then printf 'Exit code %s\\n' "$__ya_status" >&2; fi; unset __ya_status; true`;
}

/** How every command the hook rewrote begins, so secret-post can tell one that may hold a secret. */
export function readerPrefix(reader: string[]): string {
  return `eval "$(${reader.map(shellQuote).join(' ')}`;
}
