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
import { Inbox } from '../core/inbox.ts';
import { focusHerdrPane } from '../integrations/herdr/focus.ts';
import { homeDir, writePrivate } from './home.ts';

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
async function localToken(inbox: Inbox, home: string, role: 'owner' | 'agent'): Promise<string> {
  const file = path.join(home, `${role}-token`);
  if (fs.existsSync(file)) {
    const secret = fs.readFileSync(file, 'utf8').trim();
    if (await inbox.authenticate(secret)) return secret;
  }
  const { secret } = await inbox.createToken(`${role === 'owner' ? 'page' : 'local agents'} on ${os.hostname()}`, role);
  writePrivate(file, secret);
  return secret;
}

function inboxId(home: string): string {
  const file = path.join(home, 'inbox-id');
  if (!fs.existsSync(file)) writePrivate(file, randomId(8));
  return fs.readFileSync(file, 'utf8').trim();
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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const url = `http://${opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host}:${port}`;
  writePrivate(path.join(home, 'server.json'), JSON.stringify({ url, port, pid: process.pid }));

  // The platform alarm for this build.
  const alarm = setInterval(() => inbox.sweep(), 30_000);
  let ad: Advertisement | undefined;
  if (opts.mdns) ad = advertise({ port, inboxId: inboxId(home) });
  let watcher: fs.FSWatcher | undefined;
  if (opts.watch !== false) {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    watcher = fs.watch(WEB, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => inbox.announceCode(), 150);
    });
  }
  log(`inbox on ${url}${opts.mdns ? ', advertised over mDNS' : ''}`);

  return {
    url,
    port,
    ownerToken: secret,
    inbox,
    async close() {
      clearInterval(alarm);
      watcher?.close();
      await ad?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
