// Prove secret sources on your own inbox while it runs, end to end, with the code an agent session runs:
//
//   node scripts/prove-secret-sources.ts NAME [--expect-sha256 HEX]
//
// It reads the inbox's address and tokens from YOUR_ATTENTION_HOME (or ~/.your-attention), then:
//   1. lists the secret sources, and needs one that is ready;
//   2. looks NAME up, and needs a candidate;
//   3. posts a card whose secret_access widget card_post's own prepare fills, with the session's key pair;
//   4. answers it as the owner, granting that candidate for one hour;
//   5. takes the answer from the agent stream, checks it holds ciphertext only, and opens it in memory;
//   6. revokes the grant, and checks the revoke event ends it;
//   7. checks that no file under the home holds the value.
// It prints each step and never the value. With --expect-sha256 it compares the value's SHA-256 with the one given, so
// a run on a real store proves the right secret came back without anyone seeing it. It exits 1 at the first failed step.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../src/client.ts';
import { filesHolding } from '../test/files-holding.ts';
import type { Candidate, SourceInfo } from '../src/core/secret-sources.ts';
import type { AgentEvent } from '../src/core/types.ts';
import { SecretRequests } from '../src/integrations/secrets.ts';
import { homeDir } from '../src/node/home.ts';

export interface ProofInput {
  url: string;
  agentToken: string;
  ownerToken: string;
  /** The secret's name, which the card asks for and the agent's commands would read as $NAME. */
  name: string;
  /** The value the grant must open to. A test gives it; a run on a real store gives `expectSha256` instead. */
  expected?: string;
  expectSha256?: string;
  /** The inbox's home, which step 7 searches for the value. */
  home: string;
  /** The agent id the card is posted for. */
  agent?: string;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export interface ProofResult {
  ok: boolean;
  lines: string[];
  card?: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The names of the places whose text holds `value`. The proof checks them with the value the session opened, so a run
 * that only knows the SHA-256 still finds a leak. */
export function leaks(value: string, places: Record<string, string>): string[] {
  return Object.entries(places).filter(([, text]) => value !== '' && text.includes(value)).map(([name]) => name);
}

export async function prove(input: ProofInput): Promise<ProofResult> {
  const lines: string[] = [];
  const say = (line: string): void => { lines.push(line); (input.log ?? console.log)(line); };
  const fail = (line: string): ProofResult => { say(`FAIL ${line}`); return { ok: false, lines }; };
  const agent = input.agent ?? 'prove-secret-sources';
  const timeoutMs = input.timeoutMs ?? 60_000;
  const call = async (token: string, method: string, route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${input.url}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { error: text }; }
    return { status: res.status, json };
  };

  // 1. Sources.
  const listed = await call(input.agentToken, 'GET', '/v1/secrets/sources');
  if (listed.status !== 200) return fail(`GET /v1/secrets/sources answered ${listed.status}: ${JSON.stringify(listed.json)}`);
  const sources = (listed.json['sources'] ?? []) as SourceInfo[];
  for (const s of sources) say(`source ${s.name} on ${s.instance}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
  if (!sources.some((s) => s.status === 'ready')) return fail('no secret source is ready, so serve did not load one, or none found its store');

  // 2. Lookup.
  const client = new Client({ url: input.url, token: input.agentToken });
  const found = await client.secretLookup({ name: input.name });
  const candidate: Candidate | undefined = found.candidates[0];
  if (!candidate) return fail(`the lookup of ${input.name} found no candidate`);
  for (const c of found.candidates) say(`candidate ${c.label} from ${c.source} on ${c.instance}${c.store ? ` in ${c.store}` : ''}`);

  // 3. The card, filled by card_post's own prepare.
  const secrets = new SecretRequests();
  const body = `root = Card([ask])\nask = widget secret_access {"name": ${JSON.stringify(input.name)}, "query": {"name": ${JSON.stringify(input.name)}}}`;
  const prepared = await secrets.prepare(body, (q) => client.secretLookup(q));
  const card = await client.post({ agent, title: `Grant ${input.name} to the proof of secret sources`, body: prepared.body });
  prepared.keep(card.id);
  say(`card ${card.id} asks for ${input.name}, and lists ${found.candidates.length} candidate(s)`);

  const events: AgentEvent[] = [];
  const stop = new AbortController();
  void client.stream(agent, (ev) => { events.push(ev); }, stop.signal).catch(() => {});
  const next = async <T extends AgentEvent>(match: (ev: AgentEvent) => ev is T): Promise<T | undefined> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const i = events.findIndex(match);
      if (i >= 0) return events.splice(i, 1)[0] as T;
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  };

  try {
    // 4. The owner grants the candidate for an hour.
    const until = Date.now() + 60 * 60_000;
    const answered = await call(input.ownerToken, 'POST', `/v1/cards/${encodeURIComponent(card.id)}/answer`, { values: { [input.name]: { grant: candidate.id, source: candidate.source, instance: candidate.instance, until } } });
    if (answered.status !== 200) return fail(`the owner's answer got ${answered.status}: ${JSON.stringify(answered.json)}`);
    say(`the owner granted ${candidate.label} until ${new Date(until).toISOString()}`);

    // 5. The agent stream holds ciphertext, and the session opens it in memory.
    const ev = await next((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer' && e.card.id === card.id);
    if (!ev) return fail(`no answer for ${card.id} reached the agent stream within ${timeoutMs} ms`);
    const field = ev.answer.values[input.name] as { case?: string; sealed?: { alg?: string; data?: string } } | undefined;
    if (!field?.sealed?.data) return fail(`the answer on the agent stream holds no sealed value for ${input.name}`);
    say(`the agent stream delivered case ${field.case}: ${field.sealed.alg}, ${field.sealed.data.length} characters of ciphertext`);
    const text = await secrets.receive(ev.card, ev.answer);
    const value = secrets.env(agent)[input.name];
    if (value === undefined) return fail(`the session holds no grant for ${input.name} after the answer: ${text}`);
    if (input.expected !== undefined && value !== input.expected) return fail('the value the session opened is not the one expected');
    if (input.expectSha256 !== undefined && sha256(value) !== input.expectSha256.toLowerCase()) return fail(`the value's SHA-256 is ${sha256(value)}, not ${input.expectSha256}`);
    const leaked = leaks(value, { 'the lookup answer': JSON.stringify(found), 'the answer on the agent stream': JSON.stringify(ev), 'the text for the model': text });
    if (leaked.length) return fail(`the value is in the clear in ${leaked.join(' and ')}`);
    say(`the session opened ${input.name} in memory${input.expected || input.expectSha256 ? ', and it matches' : ''} (SHA-256 ${sha256(value).slice(0, 12)}…)`);

    // 6. Revoke.
    const revoked = await call(input.ownerToken, 'POST', `/v1/cards/${encodeURIComponent(card.id)}/revoke`, { field: input.name });
    if (revoked.status !== 200) return fail(`the revoke got ${revoked.status}: ${JSON.stringify(revoked.json)}`);
    const rev = await next((e): e is Extract<AgentEvent, { type: 'revoke' }> => e.type === 'revoke' && e.card.id === card.id);
    if (!rev) return fail(`no revoke for ${card.id} reached the agent stream within ${timeoutMs} ms`);
    secrets.revoke(rev.case);
    if (secrets.env(agent)[input.name] !== undefined) return fail('the grant outlived its revoke');
    say(`the revoke of case ${rev.case} ended the grant`);

    // 7. No file under the home holds the value.
    const holding = filesHolding(input.home, value);
    if (holding.length) return fail(`these files hold the value: ${holding.join(', ')}`);
    say(`no file under ${input.home} holds the value`);
    return { ok: true, lines, card: card.id };
  } finally {
    stop.abort();
    await client.close(card.id, 'resolved', 'The proof of secret sources finished.').catch(() => {});
  }
}

/** Whether node runs this file as the command. Both sides resolve to a real path, because import.meta.url is
 * percent-encoded and follows symlinks while argv[1] is the path as typed. */
function isMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return fs.realpathSync(arg) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  const i = args.indexOf('--expect-sha256');
  const expectSha256 = i >= 0 ? args[i + 1] : undefined;
  if (!name) {
    console.error('usage: node scripts/prove-secret-sources.ts NAME [--expect-sha256 HEX]');
    process.exit(2);
  }
  const home = homeDir();
  const read = (f: string): string => fs.readFileSync(path.join(home, f), 'utf8').trim();
  let url: string;
  try {
    url = (JSON.parse(read('server.json')) as { url: string }).url;
  } catch {
    console.error(`No inbox runs in ${home}: start one with \`your-attention serve\`, with YOUR_ATTENTION_HOME set to the same folder.`);
    process.exit(1);
  }
  const result = await prove({ url, agentToken: read('agent-token'), ownerToken: read('owner-token'), name, expectSha256, home });
  console.log(result.ok ? 'PASS' : 'FAIL');
  process.exit(result.ok ? 0 : 1);
}
