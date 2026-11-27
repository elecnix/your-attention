// The laptop inbox's brokers for privileged actions. `localRunner` runs the approved command on this machine, as the
// user that runs the inbox. `sshRunner` runs it on another machine over an ssh connection the broker opens, through
// sudo on the far side. Either one writes the password to the standard input of the process it starts, and nowhere
// else: never an environment variable, an argument list, a file or a log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_OUTPUT_CHARS, NO_AUDIT_EXIT, readMachine, remoteCommand, RUN_TIMEOUT_MS, startedMark, uncovered, WRONG_MACHINE_EXIT, type PrivilegedRunner, type RemoteMachine, type RunResult } from '../core/privileged.ts';

/** Start `file` with `args`, or a shell line when `args` is undefined, write `input` to its standard input and close it,
 * and gather what it prints until it ends or the time limit stops it. */
function runProcess(file: string, args: string[] | undefined, input: string, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let output = '';
    let ended: string | undefined;
    const add = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS * 2); };
    const child = args === undefined
      ? spawn(file, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { ended = `the command ran longer than ${Math.round(timeoutMs / 1000)} seconds, so the inbox stopped it`; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    // A command that exits without reading its input closes the pipe first, and the write then fails: that is no error.
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, output, ended: `the command did not start: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, ...(ended ? { ended } : {}) });
    });
    child.stdin.end(input);
  });
}

export function localRunner(machine: string, opts: { timeoutMs?: number } = {}): PrivilegedRunner {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  // The shell of this platform reads the command, as the card shows it. Its environment is the inbox's own.
  return { machine, run: (command, password) => runProcess(command, undefined, `${password}\n`, timeoutMs) };
}

/** The exit code ssh gives for its own failures, such as a refused or dropped connection. */
const SSH_FAILED = 255;

/** The options every broker connection takes: no prompt of any kind, so nothing ever asks for input on the terminal or
 * reads the password meant for sudo; a known host key only, so a host that answers with another key is refused; no
 * forwarding, no terminal, and a dropped connection noticed within about 45 seconds. */
export const SSH_OPTIONS = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ForwardAgent=no',
  '-o', 'ForwardX11=no',
  '-o', 'ClearAllForwardings=yes',
  '-o', 'PermitLocalCommand=no',
];

/** The argument list of the ssh process for one run: options, the far account and port, then the host and the one line
 * the far side runs. The password is in none of it. */
export function sshArgs(machine: RemoteMachine, line: string): string[] {
  return [...SSH_OPTIONS, '-l', machine.user, ...(machine.port ? ['-p', String(machine.port)] : []), '--', machine.host, line];
}

/** The last line a process printed that isn't empty, for a message. */
function lastLine(text: string): string {
  return text.trim().split('\n').filter((l) => l.trim()).pop()?.trim().replace(/\.$/, '') ?? 'it printed nothing';
}

/** A broker that runs each approved command on `machine` over ssh. It starts only the ssh program, never a shell or the
 * command on this machine, so a connection that fails is a refusal and nothing runs here instead. */
export function sshRunner(machine: RemoteMachine, opts: { ssh?: string; timeoutMs?: number } = {}): PrivilegedRunner {
  const ssh = opts.ssh ?? 'ssh';
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  return {
    machine: machine.name,
    sudo: machine.sudo,
    refuse: (command) => uncovered(machine, command),
    run: async (command, password, ctx) => {
      // The rule is checked again here, so no path reaches ssh with a command it doesn't cover.
      const refused = uncovered(machine, command);
      if (refused) return { exitCode: null, output: '', ended: `nothing ran, because ${refused}` };
      const result = await runProcess(ssh, sshArgs(machine, remoteCommand(machine, command, ctx)), machine.sudo === 'password' ? `${password}\n` : '', timeoutMs);
      const started = result.output.includes(startedMark(machine.name, ctx.audit));
      if (result.ended || started) {
        if (result.exitCode === SSH_FAILED && !result.ended) return { ...result, exitCode: null, ended: `the connection to ${machine.name} ended after sudo started, so the command may have run in part: ${lastLine(result.output)}. The system log of ${machine.name} holds audit ${ctx.audit}` };
        return result;
      }
      // Before the far side printed its mark, nothing ran there, and nothing ever runs here.
      const why = result.exitCode === WRONG_MACHINE_EXIT ? `${machine.host} answered as another machine than ${machine.name}`
        : result.exitCode === NO_AUDIT_EXIT ? `the system log of ${machine.name} took no audit line`
          : result.exitCode === SSH_FAILED ? `ssh could not connect to ${machine.name} (${machine.host}): ${lastLine(result.output)}`
            : `the far side ended with exit code ${result.exitCode} before sudo started: ${lastLine(result.output)}`;
      return { exitCode: null, output: result.output, ended: `nothing ran on ${machine.name} or on this machine, because ${why}` };
    },
  };
}

export const MACHINES_FILE = 'machines.jsonl';

/** The machines of machines.jsonl in the home, and a sentence for each line that isn't one. A machine whose name is
 * this inbox's own machine, or repeats one, is refused: each name means one machine. */
export function loadMachines(home: string, local: string): { machines: RemoteMachine[]; problems: string[] } {
  let text: string;
  try { text = fs.readFileSync(path.join(home, MACHINES_FILE), 'utf8'); } catch { return { machines: [], problems: [] }; }
  const machines: RemoteMachine[] = [];
  const problems: string[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { problems.push(`line ${i + 1} of ${MACHINES_FILE} is not JSON`); continue; }
    const m = readMachine(parsed);
    if (typeof m === 'string') { problems.push(`line ${i + 1} of ${MACHINES_FILE}: ${m}`); continue; }
    if (m.name === local) { problems.push(`line ${i + 1} of ${MACHINES_FILE}: ${m.name} is this inbox's own machine, which runs its commands without ssh`); continue; }
    if (machines.some((x) => x.name === m.name)) { problems.push(`line ${i + 1} of ${MACHINES_FILE}: ${m.name} is already on an earlier line`); continue; }
    machines.push(m);
  }
  return { machines, problems };
}
