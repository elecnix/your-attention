// The masker of a rewritten Bash command: `exec > >(node secret-mask.ts NAME...) 2>&1` sends every byte the command
// writes through this process, which replaces each value of the named variables with [secret NAME] before Claude Code
// reads it. The values come from this process's environment, which the shell gave it after the reader's exports.
// Because the masking happens in the stream, a shell killed by a signal or replaced by `exec` still shows no value:
// this process reads to the end of its input and writes what it held back, masked.
import { Redactor } from '../../secrets/redact.ts';

const redactor = new Redactor();
for (const name of process.argv.slice(2)) {
  const value = process.env[name];
  if (value) redactor.add(name, value);
}
const stream = redactor.stream();
const decoder = new TextDecoder();
process.stdin.on('data', (chunk: Buffer) => {
  const out = stream.push(decoder.decode(chunk, { stream: true }));
  if (out) process.stdout.write(out);
});
process.stdin.on('end', () => {
  process.stdout.write(stream.push(decoder.decode()) + stream.end());
});
// A signal to the command's group reaches this process too. It writes what it held back, masked, before it ends.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    process.stdout.write(stream.end(), () => process.exit(0));
  });
}
