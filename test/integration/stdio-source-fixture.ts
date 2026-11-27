// A stdio secret source that misbehaves on request, for the tests of the stdio form. The query's name picks the fault.
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
    case 'CRASH': process.exit(3);
    case 'SETTINGS': return reply({ candidates: [{ id: 'settings', label: process.env['YOUR_ATTENTION_SOURCE_SETTINGS'] ?? '' }] });
    default: return reply({ candidates: [{ id: 'pid', label: String(process.pid) }] });
  }
});
console.error('fixture ready');
