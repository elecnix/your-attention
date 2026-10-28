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
import { agentSocket, pageSocket } from '../core/socket.ts';
import { WebSocketServer } from 'ws';
import { Inbox } from '../core/inbox.ts';
import { focusHerdrPane } from '../integrations/herdr/focus.ts';
import { homeDir, writePrivate } from './home.ts';
import { relayClient } from './links.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function vendorDir(): string {
  const url = import.meta.resolve('@openuidev/browser-bundle');
  return path.dirname(fileURLToPath(url));
}

/** Vendor files that come from other packages than the OpenUI bundle. */
export const VENDOR_FILES: Record<string, string> = { 'qrcode.mjs': fileURLToPath(import.meta.resolve('qrcode-generator')) };

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
  /** Runs when the owner asks the inbox to stop. The default closes the server. */
  onShutdown?: () => void;
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
  const file = vendor && VENDOR_FILES[rel] ? VENDOR_FILES[rel] : path.resolve(base, rel);
  if (!(vendor && VENDOR_FILES[rel]) && !file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
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
  let listening = 0;
  // A phone on the same network reaches the inbox at the computer's .local name, or at one of its addresses.
  const networkAddresses = (): string[] => {
    if (!listening || !['0.0.0.0', '::'].includes(opts.host)) return [];
    const name = os.hostname().replace(/\.local$/i, '');
    // Tunnels, VPNs and container bridges carry addresses a phone on the same Wi-Fi never reaches.
    const lan = Object.entries(os.networkInterfaces())
      .filter(([iface]) => !/^(lo|utun|tun|tap|wg|ppp|ipsec|gif|stf|awdl|llw|anpi|bridge|docker|br-|veth|virbr|vmnet|vethernet|tailscale|zt)/i.test(iface))
      .flatMap(([, list]) => list ?? [])
      // 100.64.0.0/10 is the carrier-grade range VPNs such as Tailscale use.
      .filter((i) => !i.internal && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address));
    // IPv6 first: a VPN that routes the LAN's IPv4 elsewhere often leaves IPv6 alone.
    const v6 = opts.host === '::' ? lan.filter((i) => i.family === 'IPv6' && !/^fe80/i.test(i.address)).map((i) => `http://[${i.address}]:${listening}`) : [];
    const v4 = lan.filter((i) => i.family === 'IPv4').map((i) => `http://${i.address}:${listening}`);
    return [`http://${name}.local:${listening}`, ...v6, ...v4];
  };
  const handle = createHandler(inbox, { openOrigin: focusHerdrPane, networkAddresses });

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && !pathname.startsWith('/v1/') && serveStatic(pathname, res)) return;
    // `your-attention stop` asks here. Only the owner may stop the inbox, and only on this build.
    if (req.method === 'POST' && pathname === '/v1/shutdown') {
      const caller = await inbox.authenticate(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
      const status = !caller ? 401 : caller.role !== 'owner' ? 403 : 202;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 202 ? { ok: true } : { error: status === 401 ? 'Sign in first.' : 'Only the owner can stop the inbox.' }));
      if (status === 202) setImmediate(opts.onShutdown ?? (() => void running.close()));
      return;
    }
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
    if (u.pathname === '/v1/ws' && u.searchParams.get('page') === '1') {
      // The inbox page signs in with its cookie, which the browser sends with the upgrade.
      const auth = req.headers.authorization;
      const secret = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : /(?:^|;\s*)ya_token=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
      let decoded: string | undefined;
      try { decoded = secret ? decodeURIComponent(secret) : undefined; } catch { decoded = undefined; }
      const t = await inbox.authenticate(decoded);
      if (t?.role !== 'owner') { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
      const viewer = u.searchParams.get('viewer') ?? undefined;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = pageSocket(inbox, { send: (text) => ws.send(text), close: (c, r) => ws.close(c, r) }, viewer && /^[\w-]{4,64}$/.test(viewer) ? viewer : undefined);
        ws.on('message', (d) => conn.message(String(d)));
        ws.on('close', () => conn.close());
      });
      return;
    }
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
      const conn = agentSocket(inbox, agent, { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) }, caller, u.searchParams.get('instance') ?? undefined);
      // A connection that misses a heartbeat is gone, and presence follows within seconds.
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const beat = setInterval(() => {
        if (!alive || !conn.authenticated) return void ws.terminate();
        alive = false;
        ws.ping();
      }, opts.heartbeatMs ?? 15_000);
      ws.on('message', (d) => { conn.message(String(d)).catch(() => ws.close(1011, 'the frame could not be handled')); });
      ws.on('close', () => { clearInterval(beat); conn.close(); });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      // A machine without IPv6 cannot listen on ::, so the inbox listens on every IPv4 address instead.
      if (opts.host !== '::' || !['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(e.code ?? '')) return reject(e);
      opts = { ...opts, host: '0.0.0.0' };
      server.once('error', reject);
      server.listen(opts.port, opts.host, resolve);
    });
    server.listen(opts.port, opts.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  listening = port;
  const url = `http://${opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host}:${port}`;
  const serverInfo = JSON.stringify({ url, port, pid: process.pid });
  writePrivate(path.join(home, 'server.json'), serverInfo);

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

  const running: RunningServer = {
    url,
    port,
    ownerToken: secret,
    inbox,
    async close() {
      clearInterval(alarm);
      relay?.stop();
      watcher?.close();
      await ad?.stop();
      // Let each socket's close handler update presence before the database closes.
      await Promise.all([...wss.clients].map((ws) => new Promise<void>((r) => { ws.once('close', () => r()); ws.terminate(); })));
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      // Forget the address, unless another server has written its own since.
      const info = path.join(home, 'server.json');
      try { if (fs.readFileSync(info, 'utf8') === serverInfo) fs.rmSync(info); } catch {}
    },
  };
  return running;
}
