// A client for agents and integrations. It finds the inbox in this order:
// 1. YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN
// 2. ~/.your-attention/client.json, written by `your-attention pair`
// 3. the inbox running on this machine, with its local agent token
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Answer, Card, CloseKind, NewCard } from './core/types.ts';
import { homeDir } from './node/home.ts';

export interface ClientConfig {
  url: string;
  token: string;
}

export function loadConfig(home = homeDir()): ClientConfig | undefined {
  const url = process.env['YOUR_ATTENTION_URL'];
  const token = process.env['YOUR_ATTENTION_TOKEN'];
  if (url && token) return { url, token };
  const read = (f: string): string | undefined => {
    try { return fs.readFileSync(path.join(home, f), 'utf8').trim(); } catch { return undefined; }
  };
  const paired = read('client.json');
  if (paired) return JSON.parse(paired) as ClientConfig;
  const server = read('server.json');
  const agentToken = read('agent-token');
  if (server && agentToken) return { url: (JSON.parse(server) as { url: string }).url, token: agentToken };
  return undefined;
}

export class Client {
  readonly url: string;
  private readonly token: string;

  constructor(config: ClientConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.token = config.token;
  }

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${data.error ?? ''}`.trim());
    return data;
  }

  post(card: NewCard): Promise<Card> { return this.call('POST', '/v1/cards', card); }
  list(): Promise<{ card: Card; state: string }[]> { return this.call('GET', '/v1/cards'); }
  get(id: string): Promise<{ card: Card; state: string }> { return this.call('GET', `/v1/cards/${encodeURIComponent(id)}`); }
  close(id: string, kind: CloseKind, outcome: string, ifUnanswered = false): Promise<Card> {
    return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/close`, { kind, outcome, ifUnanswered });
  }
  reply(id: string, text: string): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/reply`, { text }); }
  ack(id: string): Promise<Answer> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/ack`, {}); }
  claim(id: string, agent: string): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/claim`, { agent }); }
  search(q: string): Promise<{ card: Card; answer?: Answer }[]> { return this.call('GET', `/v1/search?q=${encodeURIComponent(q)}`); }
  deadLetters(): Promise<{ card: Card; answer: Answer }[]> { return this.call('GET', '/v1/dead-letters'); }

  /** Receive answers for one agent until `signal` aborts. Reconnects after a drop. */
  async stream(agent: string, onEvent: (ev: AgentEvent) => void | Promise<void>, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.url}/v1/stream?agent=${encodeURIComponent(agent)}`, {
          headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let end: number;
          while ((end = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, end);
            buf = buf.slice(end + 2);
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const ev = JSON.parse(data.slice(6)) as AgentEvent | { type: 'beat' };
            if (ev.type !== 'beat') await onEvent(ev);
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Plain text for an answer, as an agent reads it. */
export function describeAnswer(card: Card, answer: Answer): string {
  // A sealed secret is never written out: the integration opens it.
  if (card.kind === 'secret') return answer.comment ? `(a sealed secret)\nComment: ${answer.comment}` : '(a sealed secret)';
  const lines: string[] = [];
  if (card.questions?.length) {
    card.questions.forEach((q, i) => {
      const v = [answer.values[`q${i}`] ?? []].flat();
      lines.push(`${q.question} ${v.length ? v.join(', ') : '(no option picked)'}`);
    });
  }
  for (const [k, v] of Object.entries(answer.values)) {
    if (card.questions?.length && /^q\d+$/.test(k)) continue;
    const label = k === 'choice' && card.options
      ? [v].flat().map((x) => card.options?.find((o) => o.id === x)?.label ?? String(x)).join(', ')
      : [v].flat().join(', ');
    lines.push(`${k}: ${label}`);
  }
  if (answer.comment) lines.push(`Comment: ${answer.comment}`);
  return lines.join('\n') || 'An empty answer: the person sent nothing more.';
}
