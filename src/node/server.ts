// The laptop build: the web-standard handler behind node:http, SQLite storage,
// mDNS discovery, and the built-in page.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlobs } from '../adapters/files.ts';
import { advertise, type Advertisement } from '../adapters/mdns.ts';
import { SqliteStorage } from '../adapters/sqlite.ts';
import { randomId } from '../core/crypto.ts';
import { createHandler } from '../core/http.ts';
import type { Caller } from '../core/inbox.ts';
import { agentSocket } from '../core/socket.ts';
import { WebSocketServer } from 'ws';
import { Inbox } from '../core/inbox.ts';
import { focusHerdrPane } from '../integrations/herdr/focus.ts';
import { homeDir, writePrivate } from './home.ts';
import { relayClient } from './links.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function vendorDir(): string {
  const url = import.meta.resolve('@openuidev/browser-bundle');
  return path.dirname(fileURLToPath(url));
}

export interface ServeOptions {
  port: number;
  host: string;
  home?: string;
  mdns: boolean;
  /** Reload open pages when a file under web/ changes. */
  watch?: boolean;
  /** Milliseconds between WebSocket heartbeats. */
  heartbeatMs?: number;
  /** Dial out to a relay and offer the inbox there. */
  relay?: { url: string; key: string };
  log?: (...args: unknown[]) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  ownerToken: string;
  inbox: Inbox;
  close(): Promise<void>;
}

/** A token kept in a file only this user can read, for the page and for local agents. */
async function localToken(inbox: Inbox, home: string, role: 'owner' | 'agent' | 'extension'): Promise<string> {
  const file = path.join(home, `${role}-token`);
  if (fs.existsSync(file)) {
    const secret = fs.readFileSync(file, 'utf8').trim();
    if (await inbox.authenticate(secret)) return secret;
  }
  const { secret } = await inbox.createToken(`${role === 'owner' ? 'page' : role === 'agent' ? 'local agents' : 'local extensions'} on ${os.hostname()}`, role);
  writePrivate(file, secret);
  return secret;
}


function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  const vendor = pathname.startsWith('/vendor/');
  const base = vendor ? vendorDir() : WEB;
  const rel = vendor ? pathname.slice('/vendor/'.length) : pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': vendor ? 'max-age=86400' : 'no-store' });
  fs.createReadStream(file).pipe(res);
  return true;
}

export async function serve(opts: ServeOptions): Promise<RunningServer> {
  const log = opts.log ?? ((...a: unknown[]) => console.error('[your-attention]', ...a));
  const home = opts.home ?? homeDir();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const store = new SqliteStorage(path.join(home, 'inbox.sqlite'));
  const inbox = new Inbox(store, Date.now, new FileBlobs(path.join(home, 'files')));
  const secret = await localToken(inbox, home, 'owner');
  await localToken(inbox, home, 'agent');
  await localToken(inbox, home, 'extension');
  // Keep the identity an earlier version advertised in its own file.
  const idFile = path.join(home, 'inbox-id');
  if (fs.existsSync(idFile) && !store.get('meta', 'inbox-id')) store.put('meta', 'inbox-id', fs.readFileSync(idFile, 'utf8').trim());
  const handle = createHandler(inbox, { openOrigin: focusHerdrPane });

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && !pathname.startsWith('/v1/') && serveStatic(pathname, res)) return;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
      method: req.method,
      headers,
      body: chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return void res.end();
    const reader = response.body.getReader();
    res.on('close', () => { reader.cancel().catch(() => {}); });
    req.socket.setKeepAlive(true, 1000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // The client went away.
    }
    res.end();
  });

  // Agents may also connect over a WebSocket at /v1/ws?agent=<id>.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const agent = u.searchParams.get('agent');
    if (u.pathname !== '/v1/ws' || !agent) return void socket.destroy();
    let caller: Caller | undefined;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const t = await inbox.authenticate(auth.slice(7).trim());
      if (!t) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
      caller = { token: t.id, role: t.role };
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = agentSocket(inbox, agent, { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) }, caller);
      // A connection that misses a heartbeat is gone, and presence follows within seconds.
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const beat = setInterval(() => {
        if (!alive || !conn.authenticated) return void ws.terminate();
        alive = false;
        ws.ping();
      }, opts.heartbeatMs ?? 15_000);
      ws.on('message', (d) => void conn.message(String(d)));
      ws.on('close', () => { clearInterval(beat); conn.close(); });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const url = `http://${opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host}:${port}`;
  writePrivate(path.join(home, 'server.json'), JSON.stringify({ url, port, pid: process.pid }));

  // The platform alarm for this build.
  // The platform alarm for this build: presence grace and hook timeouts need about a second.
  const alarm = setInterval(() => inbox.sweep(), 1000);
  let ad: Advertisement | undefined;
  if (opts.mdns) ad = advertise({ port, inboxId: inbox.id() });
  let watcher: fs.FSWatcher | undefined;
  if (opts.watch !== false) {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    watcher = fs.watch(WEB, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => inbox.announceCode(), 150);
    });
  }
  const relay = opts.relay ? relayClient({ relay: opts.relay.url, key: opts.relay.key, inboxId: inbox.id(), local: url, log }) : undefined;
  log(`inbox on ${url}${opts.mdns ? ', advertised over mDNS' : ''}`);

  return {
    url,
    port,
    ownerToken: secret,
    inbox,
    async close() {
      clearInterval(alarm);
      relay?.stop();
      watcher?.close();
      await ad?.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
