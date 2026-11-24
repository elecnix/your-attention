// The triage extension: a service that dials in on the card.created hook and
// sends back cards that lack what the person needs to answer them. It is
// fail-open: when the judge fails, the card goes through.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Card, PersonPresence } from '../core/types.ts';
import { homeDir, writePrivate } from '../node/home.ts';
import type { ScreenMode } from '../core/hooks.ts';
import { limiter, runCardHook, type Ruling } from './card-hook.ts';

export { limiter, type Ruling };

/** `signal` aborts when the card's deadline passes or triage stops, and the judge then ends its call. */
export type Judge = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface TriageConfig {
  url: string;
  token: string;
  judge: Judge;
  name?: string;
  timeoutMs?: number;
  /** Which cards this connection screens: `open` also takes the open cards that have no verdict yet. Defaults to `new`. */
  screen?: ScreenMode;
  /** Cards checked at once. A burst of cards waits its turn instead of hitting the judge's rate limit. */
  concurrency?: number;
  log?: (...a: unknown[]) => void;
}

/** Call the judge, and retry with backoff when it is busy, until `deadline` or until `signal` aborts. */
export async function judgeWithRetry(judge: Judge, prompt: string, deadline: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), signal?: AbortSignal): Promise<string> {
  let wait = 1000;
  for (;;) {
    try {
      return await judge(prompt, signal);
    } catch (e) {
      const busy = /\b(429|50[23])\b/.test((e as Error).message);
      if (!busy || Date.now() + wait > deadline - 1000) throw e;
      await sleep(wait);
      // A card whose deadline passed while the judge was busy needs no more calls.
      if (signal?.aborted) throw new Error('triage stopped judging the card: it was aborted');
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
    'Pass it otherwise. A card with `dialog` is a question the harness also asks in the terminal, so the person can answer it there: judge it on its own terms. It needs a clear question and the options the agent weighed, but no separate recommendation, since the dialog offers none. Return it when its question does not say what the agent needs, or its options do not give the person distinct choices.',
    'A card with `secrets` asks for those values, such as an API key, in sealed fields the secret widget places: pass it when the card says why the agent needs each one. A card that asks only for a secret has no options or recommendation, by design.',
    'An HTML card brings its own form in "html": read its options and recommendation there.',
    'Return a card whose text asks two or more questions above one options list: each question goes in "questions", with its own text and options, so the person answers it beside its context.',
    '',
    `Guidance for agents: ${guidance}`,
    '',
    'The card:',
    JSON.stringify({
      kind: card.kind, dialog: card.dialog || undefined, title: card.title, text: card.text, recommendation: card.recommendation, options: card.options?.map((o) => o.label),
      questions: card.questions, secrets: card.secrets, html: card.html?.slice(0, 4000), body: card.body?.slice(0, 4000), attachments: card.attachments?.map((a) => a.name),
      tags: card.tags ?? {},
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
  return (prompt, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`${command} stopped before it started: the card's check was aborted`)); return; }
    // The command runs in a shell, and a pipeline or a chain runs as that shell's children, so it gets a process group
    // of its own and every process in it ends together.
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    let out = '';
    const timer = setTimeout(() => { killTree(child); reject(new Error(`${command} took longer than ${timeoutMs} ms`)); }, timeoutMs);
    const stop = (): void => { clearTimeout(timer); killTree(child); reject(new Error(`${command} stopped: the card's check was aborted`)); };
    signal?.addEventListener('abort', stop, { once: true });
    child.on('close', () => signal?.removeEventListener('abort', stop));
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${command} exited with ${code}`)); });
    // A command that exits without reading its input closes the pipe: its exit code is the answer, not EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** End a judge command with everything it started: its process group on POSIX, then SIGKILL after 2 s, and its tree on
 * Windows. */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  const signal = (s: NodeJS.Signals): void => { try { process.kill(-pid, s); } catch { /* the group has already ended */ } };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 2000).unref();
}

/** A judge on an OpenAI-compatible chat endpoint: OpenRouter, Ollama Cloud, or a local model. */
export function chatJudge(opts: { baseUrl: string; apiKey: string; model: string; fetcher?: typeof fetch }): Judge {
  const fetcher = opts.fetcher ?? fetch;
  return async (prompt, signal) => {
    const res = await fetcher(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(120_000), signal]) : AbortSignal.timeout(120_000),
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
  await runCardHook({ url: cfg.url, token: cfg.token, name: cfg.name ?? 'triage', timeoutMs: cfg.timeoutMs, concurrency: cfg.concurrency, screen: cfg.screen, log: cfg.log }, async (ev, call, signal) => {
    const guidance = (await call<{ text: string }>('/v1/guidance')).text;
    const words = ev.card.title.split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(' ');
    // A bare word search, so an inbox from before the paged reply and one after both answer the array.
    const hits = words ? await call<{ card: Card; answer?: { comment: string; values: Record<string, unknown> } }[]>(`/v1/search?q=${encodeURIComponent(words)}`) : [];
    const earlier = hits.filter((h) => h.card.id !== ev.card.id && h.answer).slice(0, 3)
      .map((h) => ({ title: h.card.title, answer: [JSON.stringify(h.answer?.values), h.answer?.comment].filter(Boolean).join(' ') }));
    return parseRuling(await judgeWithRetry(cfg.judge, triagePrompt(ev.card, guidance, earlier, ev.person), ev.deadline, undefined, signal));
  }, signal);
}
