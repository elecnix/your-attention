// The laptop inbox's broker for privileged actions: it runs the approved command on this machine, as the user that runs
// the inbox, and writes the password to the command's standard input. The password is an argument of `run` and the
// bytes written to the pipe, and nowhere else: never an environment variable, an argument list, a file or a log.
import { spawn } from 'node:child_process';
import { MAX_OUTPUT_CHARS, RUN_TIMEOUT_MS, type PrivilegedRunner, type RunResult } from '../core/privileged.ts';

export function localRunner(machine: string, opts: { timeoutMs?: number } = {}): PrivilegedRunner {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  return {
    machine,
    run: (command, password) => new Promise<RunResult>((resolve) => {
      let output = '';
      let ended: string | undefined;
      const add = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS * 2); };
      // The shell of this platform reads the command, as the card shows it. Its environment is the inbox's own.
      const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
      child.stdin.end(`${password}\n`);
    }),
  };
}
