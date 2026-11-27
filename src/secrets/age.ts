// Reading an age file with no terminal prompt and no plaintext file.
//
// Two shapes, because the vault has two: an age file encrypted to a recipient opens with an identity file and needs
// no terminal at all, which is how a store's passphrase can be kept in an envelope only this process can read; a
// passphrase-encrypted file insists on a terminal, so `script` provides one and the plaintext leaves age through a
// named pipe rather than a file. A named pipe has no contents on disk, so on macOS — where there is no tmpfs — the
// value still does not touch the filesystem, only its name does.
//
// Two traps are handled here because both fail silently:
//   - `age -d -o FIFO` writes nothing and exits 0, so the value is read from stdout redirected into the pipe instead,
//     and an empty read is an error rather than an empty secret.
//   - On macOS `script` has no `-c`, and `--` there is the command rather than a separator that exits 0 on failure,
//     so the Darwin form passes a shell explicitly and the exit status is always checked.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A path inside a single shell word, for the command strings `script` runs. */
const quote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

const IS_DARWIN = process.platform === 'darwin';

/** Where a pipe may live: the runtime directory when there is one (tmpfs on Linux), the temp directory otherwise. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  // An empty value counts as unset, or the pipe's directory would land in the current directory.
  return env['XDG_RUNTIME_DIR'] || os.tmpdir();
}

export interface AgeOptions {
  /** How long a decryption may take before it is killed. Age is slow on purpose; a stuck one is a bug. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** The `age` binary, for a machine that keeps it somewhere else. */
  age?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Decrypt `source` with an identity file. No terminal is opened, so this cannot prompt: an identity file is the way
 * to keep a store's passphrase somewhere only the process that owns it can read.
 */
export async function decryptWithIdentity(source: string, identity: string, options: AgeOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await run(options.age ?? 'age', ['-d', '-i', identity, source], {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options.env ?? process.env,
  });
  if (code !== 0) throw new Error(`age could not decrypt ${source} with ${identity}: ${firstLine(stderr) || `exit ${code}`}`);
  // An identity that opens nothing still exits 0 on an empty file, so the value is checked rather than the code.
  if (stdout === '') throw new Error(`${source} decrypted to nothing`);
  return stdout;
}

/**
 * Decrypt a passphrase-encrypted `source` by handing the passphrase to age through a terminal `script` gives it, and
 * reading the plaintext from a pipe. The passphrase never reaches argv, and the plaintext never reaches a file.
 */
export async function decryptWithPassphrase(source: string, passphrase: string, options: AgeOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const age = options.age ?? 'age';
  const dir = await fs.mkdtemp(path.join(runtimeDir(options.env), 'ya-age-'));
  // mkdtemp makes the directory 0700, so no other user can reach the pipe inside it.
  const pipe = path.join(dir, 'secret');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await runDetached('mkfifo', [pipe]);
    const command = `${quote(age)} -d ${quote(source)} > ${quote(pipe)}`;
    const argv = IS_DARWIN ? ['-q', '/dev/null', 'sh', '-c', command] : ['-qec', command, '/dev/null'];
    child = spawn('script', argv, { stdio: ['pipe', 'ignore', 'pipe'], env: options.env ?? process.env });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A host without `script` emits 'error' instead of 'exit'. Without a listener Node throws it and the process dies.
    const exited = new Promise<number>((resolve) => {
      child?.once('error', (e) => { stderr.push(Buffer.from(e.message)); resolve(-1); });
      child?.once('exit', (code, signal) => resolve(code ?? (signal ? -1 : 0)));
    });
    // The passphrase goes in and the stream closes, so age reads one line and finds no more.
    child.stdin?.on('error', () => {}); // script may exit before the write lands; the exit status says whether it worked
    child.stdin?.end(`${passphrase}\n`);
    const reading = readPipe(pipe, timeoutMs);
    // A child that dies before age opens the pipe leaves the reader blocked in open(), on a thread Node cannot cancel,
    // and the process never exits. Opening the write end and closing it gives that reader an end of file.
    const [text, code] = await Promise.all([reading, exited.then(async (c) => { if (c !== 0) await release(pipe); return c; })]);
    if (code !== 0) throw new Error(`age could not decrypt ${source}: ${firstLine(Buffer.concat(stderr).toString('utf8')) || `exit ${code}`}`);
    if (text === '') throw new Error(`${source} decrypted to nothing; the passphrase may be wrong`);
    return text;
  } finally {
    child?.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Read a named pipe to its end, giving up after `timeoutMs` and closing the stream rather than leaving it open. */
function readPipe(pipe: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(pipe);
    const timer = setTimeout(() => {
      void release(pipe);
      stream.destroy();
      reject(new Error(`nothing came out of the pipe within ${timeoutMs} ms`));
    }, timeoutMs);
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
    stream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

/** Open the write end of `pipe` and close it at once, so a reader blocked opening it gets an end of file. The open
 * does not block: with no reader left it fails with ENXIO, which means nothing waits on the pipe. */
async function release(pipe: string): Promise<void> {
  try { await (await fs.open(pipe, constants.O_WRONLY | constants.O_NONBLOCK)).close(); } catch { /* no reader, or no pipe */ }
}

interface RunResult { code: number; stdout: string; stderr: string }

/** Run a command to completion, collecting both streams, and kill it rather than hang a caller. `input`, when given,
 * goes to its stdin, so a passphrase never reaches argv. A command that is not installed rejects with a sentence. */
export function run(command: string, argv: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { input } = options;
    const child = spawn(command, argv, { env: options.env ?? process.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) { child.stdin?.on('error', () => { /* the exit status says whether it worked */ }); child.stdin?.end(input); }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${command} is not installed, or not on the PATH`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

/** Run a command whose only outcome anyone reads is whether it worked. */
function runDetached(command: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`${command} failed: ${firstLine(Buffer.concat(stderr).toString('utf8')) || `exit ${code}`}`))));
  });
}

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';
