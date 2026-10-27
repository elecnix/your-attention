// Ways to offer an inbox where agents cannot reach it: a bridge on another
// machine, a reverse SSH tunnel, and a relay the inbox dials out to.
// Every link leads to the same inbox, with the same id, so clients can switch.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { advertise, type Advertisement } from '../adapters/mdns.ts';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const isLoopback = (addr: string | undefined): boolean => !!addr && /^(127\.|::1$|::ffff:127\.)/.test(addr);

function forwardHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === 'string' && !HOP.has(k)) out[k] = v;
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function pipeResponse(res: http.ServerResponse, upstream: Response): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((v, k) => { if (!HOP.has(k)) headers[k] = v; });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return void res.end();
  const reader = upstream.body.getReader();
  res.on('close', () => { reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // The client or the upstream went away.
  }
  res.end();
}

export interface Running {
  url: string;
  close(): Promise<void>;
}

/** A bridge: a local proxy to a remote inbox. Callers on this machine may omit the token,
 * and the bridge adds its own. Callers from the LAN bring their own token. */
export async function bridge(opts: { upstream: string; token: string; port: number; host?: string; mdns?: boolean }): Promise<Running> {
  const upstream = opts.upstream.replace(/\/$/, '');
  const auth = (req: http.IncomingMessage): string | undefined => req.headers.authorization ?? (isLoopback(req.socket.remoteAddress) ? `Bearer ${opts.token}` : undefined);
  const server = http.createServer(async (req, res) => {
    try {
      const headers = forwardHeaders(req.headers);
      const a = auth(req);
      if (a) headers['authorization'] = a;
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const ctl = new AbortController();
      res.on('close', () => ctl.abort());
      await pipeResponse(res, await fetch(`${upstream}${req.url ?? '/'}`, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, signal: ctl.signal, redirect: 'manual' }));
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `the inbox behind this bridge did not answer: ${(e as Error).message}` }));
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const a = auth(req);
    const up = new WebSocket(`${upstream.replace(/^http/, 'ws')}${req.url ?? '/'}`, { headers: a ? { authorization: a } : {} });
    up.on('error', () => socket.destroy());
    up.on('open', () => wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (d) => up.send(String(d)));
      up.on('message', (d) => ws.send(String(d)));
      ws.on('close', () => up.close());
      up.on('close', () => ws.close());
    }));
  });
  await new Promise<void>((r) => server.listen(opts.port, opts.host ?? '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let ad: Advertisement | undefined;
  if (opts.mdns) {
    // Advertise the bridge under the upstream inbox's own id: it is one more link to the same inbox.
    const info = (await (await fetch(`${upstream}/v1/info`)).json()) as { id: string };
    ad = advertise({ port, inboxId: info.id, name: `your-attention bridge on ${opts.host ?? 'localhost'}` });
  }
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await ad?.stop();
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Offer the local inbox on a remote machine through a reverse SSH tunnel. Restarts the tunnel when it drops. */
export function offerOverSsh(opts: { host: string; localPort: number; remotePort: number; log?: (...a: unknown[]) => void }): { stop(): void } {
  const log = opts.log ?? ((...a: unknown[]) => console.error('[offer]', ...a));
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  const start = (): void => {
    // A shared master connection would let ssh exit at once, so the tunnel gets a connection of its own.
    child = spawn('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-R', `127.0.0.1:${opts.remotePort}:127.0.0.1:${opts.localPort}`, opts.host], { stdio: ['ignore', 'ignore', 'inherit'] });
    log(`offering the inbox on ${opts.host} at http://127.0.0.1:${opts.remotePort}`);
    child.on('exit', (code) => {
      if (stopped) return;
      log(`the tunnel closed (exit ${code}); trying again in 5 seconds`);
      setTimeout(start, 5000);
    });
  };
  start();
  return { stop() { stopped = true; child?.kill(); } };
}

// ---- relay ----
//
// The inbox dials out to the relay over a WebSocket and registers its id.
// The relay serves http(s)://relay/i/<inbox id>/<path> and forwards each request as frames:
//   relay -> inbox  {t: "req", id, method, path, headers, body}   body in base64
//   inbox -> relay  {t: "head", id, status, headers}, then {t: "data", id, chunk}, then {t: "end", id}
//   relay -> inbox  {t: "cancel", id} when the caller goes away
// The relay sees the traffic but holds no token: every request still needs the inbox's own token.

type Frame =
  | { t: 'req'; id: string; method: string; path: string; headers: Record<string, string>; body?: string }
  | { t: 'head'; id: string; status: number; headers: Record<string, string> }
  | { t: 'data'; id: string; chunk: string }
  | { t: 'end'; id: string }
  | { t: 'cancel'; id: string };

export async function relayServer(opts: { port: number; host?: string; key: string }): Promise<Running> {
  const inboxes = new Map<string, WebSocket>();
  const waiting = new Map<string, { res: http.ServerResponse }>();
  let next = 0;
  const server = http.createServer(async (req, res) => {
    const m = /^\/i\/([\w-]+)(\/.*)?$/.exec(req.url ?? '');
    const ws = m ? inboxes.get(m[1] ?? '') : undefined;
    if (!m || !ws) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no inbox with this id is connected to the relay"}');
    const id = String(++next);
    waiting.set(id, { res });
    res.on('close', () => { if (waiting.delete(id)) ws.send(JSON.stringify({ t: 'cancel', id })); });
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    ws.send(JSON.stringify({ t: 'req', id, method: req.method ?? 'GET', path: m[2] || '/', headers: forwardHeaders(req.headers), body: body?.toString('base64') } satisfies Frame));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://relay');
    const inbox = u.searchParams.get('inbox') ?? '';
    if (u.pathname !== '/connect' || req.headers['x-relay-key'] !== opts.key || !/^[\w-]{4,64}$/.test(inbox)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      inboxes.get(inbox)?.close();
      inboxes.set(inbox, ws);
      ws.on('message', (d) => {
        const f = JSON.parse(String(d)) as Frame;
        const w = waiting.get(f.id);
        if (!w) return;
        if (f.t === 'head') w.res.writeHead(f.status, f.headers);
        else if (f.t === 'data') w.res.write(Buffer.from(f.chunk, 'base64'));
        else if (f.t === 'end') { waiting.delete(f.id); w.res.end(); }
      });
      ws.on('close', () => { if (inboxes.get(inbox) === ws) inboxes.delete(inbox); });
    });
  });
  await new Promise<void>((r) => server.listen(opts.port, opts.host ?? '0.0.0.0', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Dial out from the inbox to a relay, and serve the requests that arrive there from the local server. */
export function relayClient(opts: { relay: string; key: string; inboxId: string; local: string; log?: (...a: unknown[]) => void }): { stop(): void } {
  const log = opts.log ?? ((...a: unknown[]) => console.error('[relay]', ...a));
  let stopped = false;
  let ws: WebSocket | undefined;
  const open = new Map<string, AbortController>();
  const connect = (): void => {
    ws = new WebSocket(`${opts.relay.replace(/^http/, 'ws').replace(/\/$/, '')}/connect?inbox=${encodeURIComponent(opts.inboxId)}`, { headers: { 'x-relay-key': opts.key } });
    const sock = ws;
    sock.on('open', () => log(`offered at ${opts.relay.replace(/\/$/, '')}/i/${opts.inboxId}`));
    sock.on('message', async (d) => {
      const f = JSON.parse(String(d)) as Frame;
      if (f.t === 'cancel') return void open.get(f.id)?.abort();
      if (f.t !== 'req') return;
      const ctl = new AbortController();
      open.set(f.id, ctl);
      const send = (frame: Frame): void => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(frame)); };
      try {
        const res = await fetch(`${opts.local}${f.path}`, { method: f.method, headers: f.headers, body: f.body ? new Uint8Array(Buffer.from(f.body, 'base64')) : undefined, signal: ctl.signal, redirect: 'manual' });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { if (!HOP.has(k)) headers[k] = v; });
        send({ t: 'head', id: f.id, status: res.status, headers });
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            send({ t: 'data', id: f.id, chunk: Buffer.from(value).toString('base64') });
          }
        }
      } catch {
        // The caller went away, or the local server failed.
      }
      open.delete(f.id);
      send({ t: 'end', id: f.id });
    });
    sock.on('error', (e) => log('relay connection failed:', e.message));
    sock.on('close', () => {
      for (const c of open.values()) c.abort();
      open.clear();
      if (!stopped) setTimeout(connect, 2000);
    });
  };
  connect();
  return { stop() { stopped = true; ws?.close(); } };
}
