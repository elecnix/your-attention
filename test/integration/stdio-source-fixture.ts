// A stdio secret source that misbehaves on request, for the tests of the stdio form. The query's name picks the fault.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line) as { id: string; call: string; query?: { name?: string } };
  const reply = (body: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify({ v: 1, id: r.id, ...body })}\n`); };
  if (r.call === 'detect') return reply({ status: 'ready' });
  if (r.call === 'release') return reply({ value: 'plain, which a source must never answer' });
  switch (r.query?.name) {
    case 'GARBLE': process.stdout.write('this is not json\n'); return;
    case 'V2': process.stdout.write(`${JSON.stringify({ v: 2, id: r.id, candidates: [] })}\n`); return;
    case 'HANG': return;
    // Ignores the polite signal, and hangs: only SIGKILL ends it.
    case 'STUBBORN': process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return;
    case 'CRASH': process.exit(3);
    // Exits at once, and leaves its reply to a helper that shares its stdout and writes a moment later: the exit comes
    // before the reply, and the reply must still count.
    case 'LAST': {
      const line = JSON.stringify({ v: 1, id: r.id, candidates: [{ id: 'last', label: 'the last word' }] });
      spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(`${line}\n`)}), 300)`], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref();
      process.exit(0);
    }
    case 'SETTINGS': return reply({ candidates: [{ id: 'settings', label: process.env['YOUR_ATTENTION_SOURCE_SETTINGS'] ?? '' }] });
    default: return reply({ candidates: [{ id: 'pid', label: String(process.pid) }] });
  }
});
console.error('fixture ready');
