// A client for agents and integrations. It finds the inbox in this order:
// 1. YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN
// 2. ~/.your-attention/client.json, written by `your-attention pair`
// 3. the inbox running on this machine, with its local agent token
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Answer, Card, CloseKind, Guidance, NewCard, Template } from './core/types.ts';
import { homeDir } from './node/home.ts';

export interface ClientConfig {
  url: string;
  token: string;
  /** More links to the same inbox: a relay, a bridge, or an SSH tunnel. The client switches when one fails. */
  urls?: string[];
  /** The inbox id from GET /v1/info. Pairing saves it. Without it, the client learns it from the first link only. */
  id?: string;
}

/** The inbox and token for an extension: YOUR_ATTENTION_URL with YOUR_ATTENTION_TOKEN, or the local extension token. */
export function loadExtensionConfig(home = homeDir()): ClientConfig | undefined {
  const url = process.env['YOUR_ATTENTION_URL'];
  const token = process.env['YOUR_ATTENTION_TOKEN'];
  if (url && token) return { url, token };
  try {
    const server = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')) as { url: string };
    return { url: server.url, token: fs.readFileSync(path.join(home, 'extension-token'), 'utf8').trim() };
  } catch {
    return undefined;
  }
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

/** The inbox this machine paired with as owner, for the commands that act as the person: owner.json, written by
 * `your-attention pair --role owner`, or an owner pairing that an older version saved in client.json. */
export function ownerPairing(home = homeDir()): (ClientConfig & { source: string }) | undefined {
  for (const f of ['owner.json', 'client.json']) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(home, f), 'utf8')) as ClientConfig;
      if (c.url && c.token) return { ...c, url: c.url.replace(/\/$/, ''), source: path.join(home, f) };
    } catch { /* no such pairing */ }
  }
  return undefined;
}

/** What to do on a machine whose only pairing with `url` is an agent's. */
export function notOwnerAdvice(url: string): string {
  return `This machine is paired with ${url} as an agent, so it can't act as you. Pair it as owner with \`your-attention pair ${url} --role owner\`, which keeps the agent pairing. Or open the inbox on your phone from the phone button of a page that is signed in.`;
}

export type Transport = 'auto' | 'sse' | 'ws' | 'poll';

export class Client {
  /** The link in use. */
  url: string;
  /** Every link to the same inbox, tried in order. */
  readonly urls: string[];
  private readonly token: string;
  private inboxId: string | undefined;
  /** Answers already handed to the agent, so one that arrives over two links counts once. */
  private readonly seen = new Set<string>();
  /** This process, the same across reconnects, so the inbox sends a restarted agent the answers its earlier process never read. */
  readonly instance = crypto.randomUUID();

  constructor(config: ClientConfig) {
    this.urls = [config.url, ...(config.urls ?? [])].map((u) => u.replace(/\/$/, ''));
    this.url = this.urls[0] ?? '';
    this.token = config.token;
    this.inboxId = config.id;
  }

  /** Check that a link leads to the same inbox as the first link. A link to another inbox is skipped,
   * and so is every other link while the client does not know which inbox the first one leads to. */
  private async sameInbox(url: string): Promise<boolean> {
    const idOf = async (u: string): Promise<string | undefined> =>
      ((await (await fetch(`${u}/v1/info`, { signal: AbortSignal.timeout(5000) })).json()) as { id?: string }).id;
    if (!this.inboxId) {
      try { this.inboxId = await idOf(this.urls[0] ?? url); } catch { /* the first link is down */ }
    }
    if (url === this.urls[0]) return true;
    if (!this.inboxId) return false;
    return (await idOf(url)) === this.inboxId;
  }

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    // The same message id on every try, so the inbox applies the message once whichever link brings it.
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
    if (method !== 'GET') headers['x-message-id'] = crypto.randomUUID();
    let lastError: unknown;
    for (const url of [this.url, ...this.urls.filter((u) => u !== this.url)]) {
      let res: Response;
      try {
        if (url !== this.url && !(await this.sameInbox(url))) continue;
        res = await fetch(`${url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        lastError = e;
        continue;
      }
      this.url = url;
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${data.error ?? ''}`.trim());
      return data;
    }
    throw new Error(`${method} ${route}: no link answered (${(lastError as Error)?.message ?? 'none tried'})`);
  }

  /** True the first time an answer is seen, false for a copy from another link or a replay. */
  private fresh(ev: AgentEvent): boolean {
    if (ev.type !== 'answer') return true;
    const key = `${ev.card.id}:${ev.answer.savedAt}:${ev.answer.forcedAt ?? 0}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** The posted card. A revision the person won't see carries `warning`. */
  post(card: NewCard): Promise<Card & { warning?: string }> { return this.call('POST', '/v1/cards', card); }
  list(): Promise<{ card: Card; state: string }[]> { return this.call('GET', '/v1/cards'); }
  get(id: string): Promise<{ card: Card; state: string }> { return this.call('GET', `/v1/cards/${encodeURIComponent(id)}`); }
  close(id: string, kind: CloseKind, outcome: string, ifUnanswered = false): Promise<Card> {
    return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/close`, { kind, outcome, ifUnanswered });
  }
  patch(id: string, edits: { old: string; new: string }[], field?: string): Promise<Card & { warning?: string }> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/patch`, { edits, field }); }
  status(id: string, status: string): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/status`, { status }); }
  saveTemplate(name: string, source: string, feedback?: string): Promise<Template> { return this.call('POST', '/v1/templates', { name, source, feedback }); }
  saveWidget(name: string, source: string, feedback?: string, extra: { when?: string; response?: string } = {}): Promise<Template> { return this.call('POST', '/v1/widgets', { name, source, feedback, ...extra }); }
  /** The card guidance, and the catalog of widgets an agent can place. */
  guidance(): Promise<Guidance & { widgets?: string }> { return this.call('GET', '/v1/guidance'); }
  proposeGuidance(text: string): Promise<Card> { return this.call('POST', '/v1/guidance', { text }); }
  reply(id: string, text: string): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/reply`, { text }); }
  ack(id: string): Promise<Answer> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/ack`, {}); }
  claim(id: string, agent: string): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/claim`, { agent }); }
  search(q: string, opts: { answered?: boolean; limit?: number } = {}): Promise<{ card: Card; answer?: Answer }[]> {
    return this.call('GET', `/v1/search?q=${encodeURIComponent(q)}&limit=${opts.limit ?? 20}${opts.answered ? '&answered=1' : ''}`);
  }
  deadLetters(): Promise<{ card: Card; answer: Answer }[]> { return this.call('GET', '/v1/dead-letters'); }

  /** Receive answers for one agent until `signal` aborts. Reconnects after a drop, over the next link when one fails.
   * `auto`, the default, uses a WebSocket and falls back to server-sent events on a link that cannot carry one.
   * `poll` long-polls, for clients that cannot keep a connection. */
  async stream(agent: string, onEvent: (ev: AgentEvent) => void | Promise<void>, signal: AbortSignal, transport: Transport = 'auto'): Promise<void> {
    let link = 0;
    const noSocket = new Set<string>();
    const deliver = async (ev: AgentEvent): Promise<void> => { if (this.fresh(ev)) await onEvent(ev); };
    while (!signal.aborted) {
      const url = this.urls[link % this.urls.length] ?? this.url;
      try {
        if (this.urls.length > 1 && !(await this.sameInbox(url))) throw new Error('another inbox');
        this.url = url;
        if (transport === 'poll') await this.overPoll(url, agent, deliver, signal);
        else if (transport === 'sse' || (transport === 'auto' && noSocket.has(url))) await this.overSse(url, agent, deliver, signal);
        else {
          const opened = await this.overSocket(url, agent, deliver, signal);
          // A socket that never opened on a link that answers means the link cannot carry one. A link that does not answer is down: retry it.
          if (!opened && transport === 'auto') {
            if (!(await this.answers(url))) throw new Error('the link is down');
            noSocket.add(url);
            continue;
          }
        }
      } catch {
        if (signal.aborted) return;
        link++;
      }
      if (!signal.aborted) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async answers(url: string): Promise<boolean> {
    try { return (await fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
  }

  private async overSse(url: string, agent: string, deliver: (ev: AgentEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    const res = await fetch(`${url}/v1/stream?agent=${encodeURIComponent(agent)}&instance=${this.instance}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, end).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(end + 2);
        if (!data) continue;
        const ev = JSON.parse(data.slice(6)) as AgentEvent | { type: 'beat' };
        if (ev.type !== 'beat') await deliver(ev);
      }
    }
  }

  /** Resolves when the socket closes: true if it opened first, false if it never did. */
  private overSocket(url: string, agent: string, deliver: (ev: AgentEvent) => Promise<void>, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let opened = false;
      const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/ws?agent=${encodeURIComponent(agent)}&instance=${this.instance}`);
      const stop = (): void => ws.close();
      signal.addEventListener('abort', stop, { once: true });
      // The global WebSocket cannot send headers, so the token goes in the first frame.
      // The client pings every 20 seconds. A Durable Object answers without waking, and closes a socket that stops.
      let beat: ReturnType<typeof setInterval> | undefined;
      ws.addEventListener('open', () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'auth', token: this.token }));
        beat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 20_000);
      });
      ws.addEventListener('message', (m) => {
        let ev: { type?: string } | null;
        try { ev = JSON.parse(String(m.data)) as { type?: string } | null; } catch { return ws.close(); }
        if (ev && typeof ev === 'object' && ev.type !== 'pong' && ev.type !== 'error') deliver(ev as AgentEvent).catch(() => ws.close());
      });
      let ended = false;
      const done = (): void => {
        if (ended) return;
        ended = true;
        if (beat !== undefined) clearInterval(beat);
        signal.removeEventListener('abort', stop);
        ws.close();
        resolve(opened);
      };
      ws.addEventListener('close', done);
      // A socket that fails to connect fires error and may never fire close.
      ws.addEventListener('error', done);
    });
  }

  private async overPoll(url: string, agent: string, deliver: (ev: AgentEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const res = await fetch(`${url}/v1/poll?agent=${encodeURIComponent(agent)}&instance=${this.instance}&wait=25`, { headers: { authorization: `Bearer ${this.token}` }, signal });
      if (!res.ok) throw new Error(`poll: ${res.status}`);
      for (const ev of ((await res.json()) as { events: AgentEvent[] }).events) await deliver(ev);
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
    // A check box or switch group answers with each item on or off, by the item names the agent gave.
    const on = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((x) => (v as Record<string, unknown>)[x]) : undefined;
    const label = on ? on.join(', ') || '(none turned on)'
      : k === 'choice' && card.options
        ? [v].flat().map((x) => card.options?.find((o) => o.id === x)?.label ?? String(x)).join(', ')
        : [v].flat().join(', ');
    lines.push(`${k}: ${label}`);
  }
  if (answer.comment) lines.push(`Comment: ${answer.comment}`);
  // Each widget on the card can add text for the agent, filled from this answer, such as what to do next.
  for (const r of answer.responses ?? []) lines.push('', r);
  return lines.join('\n') || 'An empty answer: the person sent nothing more.';
}
