// The terminal client talks to the inbox the way the page does, as the owner: GET /v1/state, the page socket for live
// changes, and the answer, seen, open, focus and presence routes. It finds the inbox like the other commands: the
// YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN variables, then a machine paired with `your-attention pair --role owner`,
// then the inbox on this machine with its owner-token file. An inbox with a PIN asks for it; the client keeps the
// unlock token in memory only, and never stores or prints the PIN.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { InboxState } from '../../web/queue.js';
import { homeDir } from '../node/home.ts';

export interface OwnerConfig { url: string; token: string; source: string }

/** The inbox and an owner token, or a sentence that says what to do. */
export function ownerConfig(env: NodeJS.ProcessEnv = process.env, home = homeDir()): OwnerConfig | string {
  const url = env['YOUR_ATTENTION_URL'];
  const token = env['YOUR_ATTENTION_TOKEN'];
  if (url && token) return { url: url.replace(/\/$/, ''), token, source: 'YOUR_ATTENTION_URL' };
  const read = (f: string): string | undefined => { try { return fs.readFileSync(path.join(home, f), 'utf8').trim(); } catch { return undefined; } };
  const paired = read('client.json');
  if (paired) {
    try {
      const c = JSON.parse(paired) as { url: string; token: string };
      return { url: c.url.replace(/\/$/, ''), token: c.token, source: path.join(home, 'client.json') };
    } catch { /* fall through to the local inbox */ }
  }
  const server = read('server.json');
  const owner = read('owner-token');
  if (server && owner) return { url: (JSON.parse(server) as { url: string }).url.replace(/\/$/, ''), token: owner, source: path.join(home, 'owner-token') };
  return 'No inbox found. Start one with `your-attention start`, pair this machine as the owner with `your-attention pair <url> --role owner`, or set YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN.';
}

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body['error'] === 'string' ? body['error'] : `the inbox answered ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class InboxApi {
  readonly url: string;
  private readonly token: string;
  /** The unlock token of an inbox with a PIN, for this process only. */
  private unlock: string | undefined;
  readonly viewer = `tui-${Math.random().toString(36).slice(2, 12)}`;

  constructor(config: { url: string; token: string }) {
    this.url = config.url;
    this.token = config.token;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.token}`, 'x-your-attention': '1' };
    if (json) h['content-type'] = 'application/json';
    if (this.unlock) h['x-your-attention-unlock'] = this.unlock;
    return h;
  }

  async call<T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${route}`, { method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }

  state(): Promise<InboxState> {
    return this.call<InboxState>('GET', '/v1/state');
  }

  post(route: string, body: unknown = {}): Promise<Record<string, unknown>> {
    return this.call('POST', route, body);
  }

  /** The text of an attached file. */
  async file(id: string): Promise<string> {
    const res = await fetch(`${this.url}/v1/attachments/${encodeURIComponent(id)}`, { headers: this.headers(false), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new ApiError(res.status, {});
    return res.text();
  }

  /** Unlock an inbox that has a PIN. The answer says how many tries are left, or until when the inbox waits. */
  async unlockWith(pin: string): Promise<void> {
    const r = await this.call<{ unlock?: string }>('POST', '/v1/unlock', { pin });
    if (typeof r.unlock === 'string') this.unlock = r.unlock;
  }

  /** Tell the inbox what the person sees, as each page does. */
  report(fields: { visible?: boolean; active?: boolean; focus?: string | null }): void {
    this.post(`/v1/person/${this.viewer}`, fields).catch(() => {});
  }

  /**
   * Follow the page events: the page socket, with the event stream when the socket never opens. `onEvent` gets each
   * event type; `onUp` says whether the inbox answers. Returns a function that stops.
   */
  live(onEvent: (type: string) => void, onUp: (up: boolean, code?: number) => void): () => void {
    let stopped = false;
    let ws: WebSocket | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    let sse: AbortController | undefined;
    const watchdog = setInterval(() => { if (Date.now() - last > 5000) onUp(false); }, 1000);
    const beat = () => { last = Date.now(); onUp(true); };
    const overStream = async () => {
      sse = new AbortController();
      try {
        const res = await fetch(`${this.url}/v1/events?viewer=${this.viewer}${this.unlock ? `&unlock=${encodeURIComponent(this.unlock)}` : ''}`, { headers: this.headers(false), signal: sse.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        onEvent('change');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let at;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const type = /^event: (.+)$/m.exec(chunk)?.[1];
            if (type === 'beat') beat();
            else if (type) { beat(); onEvent(type); }
          }
        }
      } catch { /* the stream ended or failed: try again */ }
      if (!stopped) retry = setTimeout(() => { void overStream(); }, 1000);
    };
    const overSocket = () => {
      let opened = false;
      const u = `${this.url.replace(/^http/, 'ws')}/v1/ws?page=1&viewer=${this.viewer}${this.unlock ? `&unlock=${encodeURIComponent(this.unlock)}` : ''}`;
      ws = new WebSocket(u, { headers: this.headers(false) });
      ws.on('open', () => {
        opened = true;
        beat();
        onEvent('change');
        const send = () => { if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); };
        send();
        ping = setInterval(send, 2000);
      });
      ws.on('message', (d) => {
        try {
          const type = (JSON.parse(String(d)) as { type?: string }).type;
          if (type === 'beat' || type === 'pong') beat();
          else if (type) { beat(); onEvent(type); }
        } catch { /* not an event */ }
      });
      ws.on('error', () => {});
      ws.on('close', (code) => {
        clearInterval(ping);
        if (stopped) return;
        onUp(false, code);
        if (!opened) { void overStream(); return; }
        retry = setTimeout(overSocket, 1000);
      });
    };
    overSocket();
    return () => {
      stopped = true;
      clearInterval(watchdog);
      clearInterval(ping);
      clearTimeout(retry);
      sse?.abort();
      if (ws) { ws.removeAllListeners('close'); ws.on('close', () => {}); ws.close(); }
    };
  }
}
