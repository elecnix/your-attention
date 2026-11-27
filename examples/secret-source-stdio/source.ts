#!/usr/bin/env node
// An example secret source in the stdio form, with made-up values. It reads one JSON request per line on stdin and
// answers one per line on stdout, as SPEC.md#secret-sources describes, and logs to stderr. Run it with
// `node source.ts`. A real source keeps its values in a store, and seals each one inside its own process.
import readline from 'node:readline';
import { sealValue } from '../../src/core/sealed.ts';

interface Secret { label: string; type: string; host?: string; value: string }

// Made-up values. None of them opens anything.
const SECRETS: Record<string, Secret> = {
  EXAMPLE_API_KEY: { label: 'Example API key, made up', type: 'api-key', host: 'api.example.com', value: 'ex-not-a-real-key-0000' },
  EXAMPLE_DATABASE_URL: { label: 'Example database, made up', type: 'url', host: 'db.example.com', value: 'postgres://user:not-real@db.example.com/app' },
};

interface Query { name?: string; type?: string; host?: string }

/** A query matches when every field it gives agrees, and a query without a field matches nothing. */
function matches(id: string, s: Secret, q: Query): boolean {
  if (!q.name && !q.type && !q.host) return false;
  return (!q.name || q.name === id) && (!q.type || q.type === s.type) && (!q.host || q.host === s.host);
}

type Request = { v: number; id: string; call: string; query?: Query; candidate?: string; publicKey?: JsonWebKey };

async function answer(r: Request): Promise<Record<string, unknown>> {
  switch (r.call) {
    case 'detect': return { status: 'ready' };
    case 'lookup': return {
      candidates: Object.entries(SECRETS)
        .filter(([id, s]) => matches(id, s, r.query ?? {}))
        .map(([id, s]) => ({ id, label: s.label, type: s.type, ...(s.host ? { host: s.host } : {}), store: 'example' })),
    };
    case 'release': {
      const s = SECRETS[r.candidate ?? ''];
      if (!s) return { error: `the example source has no secret named ${r.candidate}` };
      if (!r.publicKey) return { error: 'release needs a public key' };
      return { sealed: await sealValue(r.publicKey, s.value) };
    }
    default: return { error: `the example source does not know the call ${r.call}` };
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    let r: Request;
    try { r = JSON.parse(line) as Request; } catch { console.error('a line on stdin is not JSON'); return; }
    // `null` and `42` are JSON too. A line without an id can't get a reply, so the source logs it and waits for the next.
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') { console.error('a line on stdin is not a request with an id'); return; }
    let reply: Record<string, unknown>;
    try { reply = await answer(r); } catch (e) { reply = { error: (e as Error).message }; }
    process.stdout.write(`${JSON.stringify({ v: 1, id: r.id, ...reply })}\n`);
  })();
});
console.error('example source started');
