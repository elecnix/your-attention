// The triage extension: a service that dials in on the card.created hook and
// sends back cards that lack what the person needs to answer them. It is
// fail-open: when the judge fails, the card goes through.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { HookEvent } from '../core/hooks.ts';
import type { Card, PersonPresence } from '../core/types.ts';
import { homeDir, writePrivate } from '../node/home.ts';

export interface Ruling {
  verdict: 'pass' | 'return';
  reason: string;
}

export type Judge = (prompt: string) => Promise<string>;

export interface TriageConfig {
  url: string;
  token: string;
  judge: Judge;
  name?: string;
  timeoutMs?: number;
  /** Judge calls at once. A burst of cards waits its turn instead of hitting the judge's rate limit. */
  concurrency?: number;
  log?: (...a: unknown[]) => void;
}

/** Run at most `limit` tasks at once, in arrival order. */
export function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (task) => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** Call the judge, and retry with backoff when it is busy, until `deadline`. */
export async function judgeWithRetry(judge: Judge, prompt: string, deadline: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  let wait = 1000;
  for (;;) {
    try {
      return await judge(prompt);
    } catch (e) {
      const busy = /\b(429|50[23])\b/.test((e as Error).message);
      if (!busy || Date.now() + wait > deadline - 1000) throw e;
      await sleep(wait);
      wait = Math.min(wait * 2, 15_000);
    }
  }
}

/** The question the judge answers for one card. */
export function triagePrompt(card: Card, guidance: string, earlier: { title: string; answer: string }[], person?: PersonPresence): string {
  return [
    'You check a card that a coding agent wants to show a person. The person has little time.',
    'Return the card when it lacks one of these: the goal, the options the agent weighed, the evidence, or a recommendation.',
    'Also return it when an earlier answer below already answers the same question.',
    'Pass it otherwise. Cards from a harness prompt that blocks the agent always pass.',
    'A secret card (kind "secret") asks for one value, such as an API key: pass it when it names the value and says why the agent needs it. It has no options or recommendation, by design.',
    'An HTML card brings its own form in "html": read its options and recommendation there.',
    '',
    `Guidance for agents: ${guidance}`,
    '',
    'The card:',
    JSON.stringify({
      kind: card.kind, title: card.title, text: card.text, recommendation: card.recommendation, options: card.options?.map((o) => o.label),
      questions: card.questions, secret: card.secret?.name, html: card.html?.slice(0, 4000), body: card.body?.slice(0, 4000), attachments: card.attachments?.map((a) => a.name),
    }, null, 2),
    '',
    earlier.length ? `Earlier answers:\n${earlier.map((e) => `- ${e.title}: ${e.answer}`).join('\n')}` : 'Earlier answers: none match.',
    '',
    `The person right now: ${describePerson(person)}`,
    'Hold yourself to a higher standard when the person is busy on another card: return a card that can wait and lacks anything.',
    '',
    'Reply with JSON only: {"verdict": "pass" or "return", "reason": "one sentence the agent can act on"}',
  ].join('\n');
}

export function describePerson(p: PersonPresence | undefined, now = Date.now()): string {
  if (!p || p.pages === 0) return 'the inbox is closed, so the card waits for them.';
  if (!p.visible) return 'the inbox is open but not on screen.';
  const idle = p.activeAt === null ? null : Math.floor((now - p.activeAt) / 60000);
  return `looking at the inbox${p.focus ? `, on card ${p.focus}` : ''}${idle === null ? '' : idle < 1 ? ', active now' : `, idle for ${idle} minutes`}.`;
}

/** Read the judge's reply. Anything unreadable passes, so a broken judge never blocks a card. */
export function parseRuling(text: string): Ruling {
  const m = /\{[\s\S]*?"verdict"[\s\S]*?\}/.exec(text);
  try {
    const v = JSON.parse(m?.[0] ?? '') as { verdict?: string; reason?: string };
    if (v.verdict === 'return') return { verdict: 'return', reason: String(v.reason ?? 'The card lacks context.') };
    return { verdict: 'pass', reason: String(v.reason ?? '') };
  } catch {
    return { verdict: 'pass', reason: 'The judge gave no readable verdict, so the card went through.' };
  }
}

/** A judge that runs a harness in print mode, such as "claude -p" or "pi -p", with the prompt on stdin. */
export function commandJudge(command: string, timeoutMs = 120_000): Judge {
  return (prompt) => new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} took longer than ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${command} exited with ${code}`)); });
    // A command that exits without reading its input closes the pipe: its exit code is the answer, not EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** A judge on an OpenAI-compatible chat endpoint: OpenRouter, Ollama Cloud, or a local model. */
export function chatJudge(opts: { baseUrl: string; apiKey: string; model: string; fetcher?: typeof fetch }): Judge {
  const fetcher = opts.fetcher ?? fetch;
  return async (prompt) => {
    const res = await fetcher(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`judge answered ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  };
}

export const OPENROUTER = 'https://openrouter.ai/api/v1';
export const OPENROUTER_KEY_FILE = (): string => path.join(homeDir(), 'openrouter-key');

/** Sign in with OpenRouter OAuth (PKCE), so triage bills your own OpenRouter account. Saves the key and returns it. */
export async function openRouterLogin(open: (url: string) => void, fetcher: typeof fetch = fetch): Promise<string> {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const c = u.searchParams.get('code');
      res.writeHead(c ? 200 : 400, { 'content-type': 'text/plain' }).end(c ? 'Signed in. You can close this tab.' : 'No code in the address.');
      if (c) { server.close(); resolve(c); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      open(`https://openrouter.ai/auth?callback_url=${encodeURIComponent(`http://localhost:${port}/callback`)}&code_challenge=${challenge}&code_challenge_method=S256`);
    });
  });
  const res = await fetcher(`${OPENROUTER}/auth/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  const data = (await res.json()) as { key?: string };
  if (!res.ok || !data.key) throw new Error(`OpenRouter refused the sign-in: ${res.status}`);
  writePrivate(OPENROUTER_KEY_FILE(), data.key);
  return data.key;
}

/** The default judge: OpenRouter with the key from openRouterLogin. */
export function defaultJudge(model = 'openrouter/auto'): Judge {
  const file = OPENROUTER_KEY_FILE();
  if (!fs.existsSync(file)) throw new Error('No OpenRouter key: run `your-attention triage login`, or pass --judge-cmd or --judge-url.');
  return chatJudge({ baseUrl: OPENROUTER, apiKey: fs.readFileSync(file, 'utf8').trim(), model });
}

/** Run triage until `signal` aborts. Reconnects after a drop, and the inbox resends calls it missed. */
export async function runTriage(cfg: TriageConfig, signal: AbortSignal): Promise<void> {
  const log = cfg.log ?? ((...a: unknown[]) => console.error(new Date().toISOString(), '[triage]', ...a));
  const base = cfg.url.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
  const run = limiter(cfg.concurrency ?? 3);
  const call = async <T>(route: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await res.json()) as T;
  };
  const decide = async (ev: Extract<HookEvent, { hook: 'card.created' }>): Promise<void> => {
    let ruling: Ruling;
    try {
      const guidance = (await call<{ text: string }>('/v1/guidance')).text;
      const words = ev.card.title.split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(' ');
      const hits = words ? await call<{ card: Card; answer?: { comment: string; values: Record<string, unknown> } }[]>(`/v1/search?q=${encodeURIComponent(words)}`) : [];
      const earlier = hits.filter((h) => h.card.id !== ev.card.id && h.answer).slice(0, 3)
        .map((h) => ({ title: h.card.title, answer: [JSON.stringify(h.answer?.values), h.answer?.comment].filter(Boolean).join(' ') }));
      ruling = parseRuling(await run(() => judgeWithRetry(cfg.judge, triagePrompt(ev.card, guidance, earlier, ev.person), ev.deadline)));
    } catch (e) {
      ruling = { verdict: 'pass', reason: `Triage failed (${(e as Error).message}), so the card went through.` };
    }
    await call(`/v1/hooks/${ev.id}`, ruling).catch((e: Error) => log('verdict failed:', e.message));
    log(ruling.verdict, ev.card.id, ruling.reason);
  };
  const q = new URLSearchParams({ name: cfg.name ?? 'triage', hooks: 'card.created', policy: 'fail-open', timeoutMs: String(cfg.timeoutMs ?? 120_000) });
  while (!signal.aborted) {
    try {
      const res = await fetch(`${base}/v1/extensions/stream?${q}`, { headers: auth, signal });
      if (!res.ok || !res.body) throw new Error(`stream: ${res.status} ${await res.text()}`);
      log('connected to', base);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let end: number;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, end).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(end + 2);
          if (!data) continue;
          const ev = JSON.parse(data.slice(6)) as HookEvent | { type: 'beat' };
          if (ev.type === 'hook' && ev.hook === 'card.created') void decide(ev);
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      log('stream failed:', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
