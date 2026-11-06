// The HTTP protocol, with fetch Request and Response only, so the same handler
// runs on Node, Bun, Deno and Workers. SPEC.md lists each route.
import { randomId } from './crypto.ts';
import { fileLinkPaths, folderFilePath } from './file-links.ts';
import { parseSessionLink } from './session-link.ts';
import type { FailurePolicy, HookName, Verdict } from './hooks.ts';
import { Inbox, InboxError, MAX_ATTACHMENT_BYTES, attachmentType, publicCard, type Caller } from './inbox.ts';
import { UNLOCK_HEADER, UNLOCK_IDLE_MS, pinKeyError, validKey, type PinKey } from './pin.ts';
import type { Source } from './telemetry.ts';
import type { AgentEvent, Card, CloseKind, Delivery, NewCard, PriorityLevel, Role, Settings, Token } from './types.ts';
import { PROTOCOL_VERSION } from './types.ts';

export const COOKIE = 'ya_token';
/** Cookie-authenticated writes must carry this header, which a cross-site form cannot set. */
export const CSRF_HEADER = 'x-your-attention';
/** Marks a reply the message store must not keep, such as one with a secret the inbox returns once. */
const ONCE_HEADER = 'x-your-attention-once';
/** A client-chosen id that makes a write idempotent across links and retries. */
export const MESSAGE_HEADER = 'x-message-id';
/** File types the page shows in place. Any other file is served as a download. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/html']);
/** The type of a local file, by its extension. Text that a browser would download, such as Markdown and CSV, shows as plain text. */
const LOCAL_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  css: 'text/css; charset=utf-8', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
/** The policy of a served file. A folder ticket's page also draws the images and fonts it embeds, and the files of its folder. */
const FILE_POLICY = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
const FOLDER_POLICY = "default-src 'none'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'";

/** The headers of a served file, shown in place or downloaded. Nothing served this way runs scripts. */
function fileHeaders(type: string, inline: boolean, name: string, cache: string, policy = FILE_POLICY): Record<string, string> {
  return {
    'content-type': type,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    // Browsers refuse to show a PDF in a sandboxed document, so a PDF gets the other limits without sandbox.
    'content-security-policy': `${type === 'application/pdf' ? '' : 'sandbox; '}${policy}`,
    'x-content-type-options': 'nosniff',
    'cache-control': cache,
  };
}

/** A folder ticket: the address of a file a card names, and with an HTML file, the files in its folder and below it. */
interface FolderTicket {
  card: string;
  /** The path the card names, and its last segment, which the address ends with. */
  file: string;
  name: string;
  /** The folder of an HTML file. A ticket for any other file opens that file only. */
  folder?: string;
  /** The token that asked for the ticket, whether the PIN gates it, and the unlock it asked under. */
  token: string;
  gated: boolean;
  unlock?: string;
}

export interface HandlerOptions {
  /** Opens the session a card came from, such as a herdr pane. */
  openOrigin?: (card: Card) => Promise<void>;
  /** Focuses the session a session link in a card points at, such as another agent's herdr tab. */
  focusSession?: (href: string) => Promise<void>;
  /** Milliseconds between keep-alive lines on a stream. */
  heartbeatMs?: number;
  /** Whether to serve the event stream, agent streams and long-polls. A platform that bills for open requests turns them off and serves WebSockets only. */
  streams?: boolean;
  /** Where a device on the same network reaches this inbox, such as http://laptop.local:4815. */
  networkAddresses?: () => string[];
  /** Where this build sends usage counts, and why it sends none, such as DO_NOT_TRACK. Without it, GET /v1/telemetry answers 404. */
  telemetry?: { source: Source; destination: string; blocked?: () => string | undefined };
  /** The files of this machine, which the laptop inbox serves for a card's file: links. `host` is this machine's name, as
   * a client puts it in a card's origin. A build with no file system has none, and GET /v1/cards/<id>/file answers 404. */
  localFiles?: { host: string; file(path: string, folder?: string): Promise<{ size: number; read(): Promise<Uint8Array<ArrayBuffer>> } | undefined> };
}

/** The largest body each kind of route reads. A card post carries its files as data: URLs. */
const BODY_LIMIT = { open: 4096, card: 16_000_000, other: 1_000_000 };
const KEY_HELP = 'key must be the PIN derived with PBKDF2-SHA256 and the salt and iterations from GET /v1/pin, 32 bytes in lowercase hex';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/** Read a JSON body of at most `max` bytes. A body that says or turns out to be larger is refused before it is all in memory. */
async function readJson<T>(req: Request, max = BODY_LIMIT.other): Promise<T> {
  const tooLarge = (): InboxError => new InboxError(413, `body over ${max} bytes`);
  if (Number(req.headers.get('content-length') ?? 0) > max) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new InboxError(400, 'body is not JSON');
  }
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** A server-sent event stream that calls `stop` when the client goes away. `end` closes it from the inbox side. */
function eventStream(start: (send: (event: string, data: unknown) => void, end: () => void) => () => void, heartbeatMs: number): Response {
  let stop = (): void => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          stop();
        }
      };
      const end = (): void => {
        if (beat !== undefined) clearInterval(beat);
        stop();
        try { controller.close(); } catch {}
      };
      stop = start(send, end);
      beat = setInterval(() => send('beat', { type: 'beat', at: Date.now() }), heartbeatMs);
    },
    cancel() {
      if (beat !== undefined) clearInterval(beat);
      stop();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
}

export function createHandler(inbox: Inbox, options: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const heartbeatMs = options.heartbeatMs ?? 2000;
  /** Whether this inbox serves the files a card names: it has a file system, and the card came from this machine. */
  const servesFiles = (card: Card): boolean => !!options.localFiles && card.origin?.host === options.localFiles.host;
  /** The folder tickets the inbox gave out. A ticket in memory ends when the inbox stops, and the page asks for a new one. */
  const tickets = new Map<string, FolderTicket>();

  /** Whether the card's text or recommendation contains a file: address whose decoded path is `path`. */
  const names = (card: Card, path: string): boolean => [card.text, card.recommendation].some((t) => fileLinkPaths(t ?? '').includes(path));

  /** Whether a ticket still opens files: its card is in the inbox, not cleared, and still names the file, its token is not
   * signed out, and with a PIN, the unlock it was asked under is live. A ticket from before the PIN has no unlock, so it ends. */
  function ticketLive(t: FolderTicket): boolean {
    let card: Card;
    try {
      card = inbox.getCard(t.card);
    } catch {
      return false;
    }
    if (card.archivedAt || !names(card, t.file) || !inbox.hasToken(t.token)) return false;
    return !t.gated || !inbox.pin.isSet() || inbox.pin.live(t.unlock);
  }

  /** The folder ticket for a file the card names, the one this caller already has or a new one. */
  function folderTicket(card: string, file: string, me: Caller, gate: { gated: boolean; unlock?: string }): FolderTicket & { id: string } {
    for (const [id, t] of tickets) if (!ticketLive(t)) tickets.delete(id);
    for (const [id, t] of tickets) {
      if (t.card === card && t.file === file && t.token === me.token && t.gated === gate.gated && t.unlock === gate.unlock) return { ...t, id };
    }
    const name = file.split('/').pop() ?? '';
    const folder = /\.html?$/i.test(name) ? file.slice(0, file.length - name.length - 1) || '/' : undefined;
    const t: FolderTicket = { card, file, name, folder, token: me.token, gated: gate.gated, unlock: gate.unlock };
    const id = randomId(24);
    tickets.set(id, t);
    return { ...t, id };
  }

  /** GET /v1/files/<ticket>/<path>: the file a ticket opens. The ticket is the credential, since a sandboxed page has an
   * opaque origin and loads its images and fonts without the cookie. */
  async function ticketFile(pathname: string): Promise<Response> {
    const local = options.localFiles;
    if (!local) return json({ error: 'this inbox serves no local files' }, 404);
    const [id = '', ...segments] = pathname.split('/').slice(3);
    const t = tickets.get(id);
    if (!t || !ticketLive(t)) {
      tickets.delete(id);
      throw new InboxError(403, 'this file link has ended: open the file again from its card');
    }
    const rest = segments.join('/');
    let named: string | undefined;
    try {
      named = decodeURIComponent(rest);
    } catch {}
    // The file the card names opens by its own path. Every other file must be in the folder of an HTML file.
    const path = named === t.name ? t.file : t.folder !== undefined ? folderFilePath(t.folder, rest) : undefined;
    if (path === undefined) throw new InboxError(403, t.folder === undefined ? 'this link opens one file only' : 'this address leaves the folder of the file the card names');
    const file = await local.file(path, path === t.file ? undefined : t.folder);
    if (!file) throw new InboxError(404, 'no such file');
    if (file.size > MAX_ATTACHMENT_BYTES) throw new InboxError(413, `the file is ${file.size} bytes, over the limit of ${MAX_ATTACHMENT_BYTES}`);
    const bytes = await file.read();
    // A file can grow between the size check and the read.
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new InboxError(413, `the file is over the limit of ${MAX_ATTACHMENT_BYTES} bytes`);
    const base = path.split('/').pop() ?? '';
    const type = LOCAL_TYPES[/\.([^.]+)$/.exec(base)?.[1]?.toLowerCase() ?? ''];
    const headers = fileHeaders(type ?? 'application/octet-stream', !!type, base, 'no-store', FOLDER_POLICY);
    // The address carries the ticket, so a link the page follows must not send it on.
    headers['referrer-policy'] = 'no-referrer';
    // A font loads in CORS mode, and the page's opaque origin is never the inbox's.
    if (type?.startsWith('font/')) headers['access-control-allow-origin'] = '*';
    return new Response(bytes, { headers });
  }

  /** The file a card names at `name`, or the refusal. The agent that posted the card chose what it exposes: the inbox
   * serves a file only when the card came from this machine and its text or recommendation names that exact path. */
  async function cardFile(card: Card, name: string): Promise<{ size: number; read(): Promise<Uint8Array<ArrayBuffer>> }> {
    const local = options.localFiles;
    if (!local) throw new InboxError(404, 'this inbox serves no local files');
    if (!servesFiles(card)) throw new InboxError(403, 'this card came from another machine');
    if (!names(card, name)) throw new InboxError(403, 'the card does not name this file');
    const file = await local.file(name);
    if (!file) throw new InboxError(404, 'no such file');
    if (file.size > MAX_ATTACHMENT_BYTES) throw new InboxError(413, `the file is ${file.size} bytes, over the limit of ${MAX_ATTACHMENT_BYTES}`);
    return file;
  }

  async function caller(req: Request): Promise<{ token: Token; viaCookie: boolean } | undefined> {
    const auth = req.headers.get('authorization');
    if (auth?.startsWith('Bearer ')) {
      const token = await inbox.authenticate(auth.slice(7).trim());
      return token ? { token, viaCookie: false } : undefined;
    }
    const token = await inbox.authenticate(cookie(req, COOKIE));
    return token ? { token, viaCookie: true } : undefined;
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.startsWith('/v1/files/')) return ticketFile(url.pathname);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1') return json({ error: 'not found' }, 404);
    const [, a, b, c] = parts;
    const method = req.method;

    // Routes open to any client on the network.
    // `checks` says what the inbox checks itself. A posting client checks the rest before it posts.
    if (method === 'GET' && a === 'info') return json({ name: 'your-attention', protocol: PROTOCOL_VERSION, id: inbox.id(), pair: '/v1/pair', checks: inbox.checks() });
    if (method === 'POST' && a === 'pair' && !b) {
      if (inbox.storageFull()) return json({ error: 'this inbox is full' }, 507);
      const body = await readJson<{ name?: string; role?: Role }>(req, BODY_LIMIT.open);
      const p = inbox.requestPairing(String(body.name ?? ''), body.role ?? 'agent');
      return json({ id: p.id, code: p.code }, 201);
    }
    if (method === 'GET' && a === 'pair' && b) return json(inbox.collectPairing(b));
    if (method === 'POST' && a === 'login') {
      const body = await readJson<{ token?: string; code?: string }>(req, BODY_LIMIT.open);
      // A sign-in code from the phone dialog becomes the device's own owner token.
      const token = body.code !== undefined ? (await inbox.redeemSignInCode(body.code)).secret : body.token;
      const t = await inbox.authenticate(token);
      if (!t || t.role !== 'owner') return json({ error: 'not an owner token' }, 401);
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${encodeURIComponent(String(token))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}` });
    }

    const who = await caller(req);
    if (!who) return json({ error: 'pair first: POST /v1/pair' }, 401);
    if (who.viaCookie && method !== 'GET' && req.headers.get(CSRF_HEADER) !== '1') return json({ error: `missing ${CSRF_HEADER} header` }, 403);
    // An EventSource cannot send headers, so the page's event stream carries its unlock token in the address.
    const unlockSecret = req.headers.get(UNLOCK_HEADER) ?? (method === 'GET' && a === 'events' ? url.searchParams.get('unlock') : null);
    const gate = await inbox.pinGate(who.token, who.viaCookie, unlockSecret);
    // A locked caller may read the PIN state, unlock, and fetch a file by its id, which only an unlocked page can list.
    const pinRoute = a === 'pin' || a === 'unlock' || a === 'lock';
    const fileRoute = method === 'GET' && a === 'attachments';
    if (gate.locked && !pinRoute && !fileRoute) return json({ error: 'this inbox is locked: type its PIN to open it', locked: true }, 423);
    const me: Caller = { token: who.token.id, role: who.token.role };
    // A full inbox takes the writes that free space or answer cards, and refuses the rest.
    const frees = method === 'DELETE' || pinRoute || (method === 'POST' && (a === 'reset' || a === 'archive' || a === 'logout' || a === 'person' || c === 'close' || c === 'dismiss' || c === 'answer' || c === 'file-ticket'));
    if (method !== 'GET' && !frees && inbox.storageFull()) return json({ error: 'this inbox is full: remove cards, templates or widgets to make room' }, 507);
    // A message that arrives over two links, or again after a retry, is applied once: the inbox
    // keeps the first result for each x-message-id, per client.
    // A PIN response carries an unlock token, and a file ticket works once, so the inbox never keeps either to replay.
    const messageId = method === 'GET' || pinRoute || c === 'file-ticket' ? null : req.headers.get(MESSAGE_HEADER);
    if (messageId !== null) {
      if (!/^[\w-]{8,64}$/.test(messageId)) return json({ error: `${MESSAGE_HEADER} must be 8 to 64 letters, digits, dashes or underscores` }, 400);
      const key = `${me.token}:${messageId}`;
      const seen = inbox.recallMessage(key);
      if (seen?.status === 0) return json({ error: 'a message with this id is still being applied; send it again shortly' }, 409);
      if (seen) return new Response(seen.body, { status: seen.status, headers: { 'content-type': 'application/json', [`${MESSAGE_HEADER}-replayed`]: '1' } });
      // Reserve the id before the await, so the same message arriving over another link at once waits.
      inbox.rememberMessage(key, 0, '');
      let res: Response;
      try {
        res = await routeAuthed(req, url, me, gate);
      } catch (e) {
        inbox.forgetMessage(key);
        throw e;
      }
      // A reply that carries a secret shown once is never kept to replay. A retry of that request makes a new subscription.
      if (res.status < 500 && !res.headers.has(ONCE_HEADER) && (res.headers.get('content-type') ?? '').startsWith('application/json')) inbox.rememberMessage(key, res.status, await res.clone().text());
      else inbox.forgetMessage(key);
      return res;
    }
    if (pinRoute) {
      if (me.role !== 'owner') return json({ error: 'only the owner can do this' }, 403);
      return pinRoutes(req, url, me, gate, unlockSecret);
    }
    return routeAuthed(req, url, me, gate);
  }

  /** A wrong PIN, or a lockout and how long it lasts. */
  function refused(r: { triesLeft: number } | { lockedUntil: number }): Response {
    if ('triesLeft' in r) return json({ error: `wrong PIN: ${r.triesLeft} ${r.triesLeft === 1 ? 'try' : 'tries'} left`, triesLeft: r.triesLeft }, 401);
    const seconds = Math.max(1, Math.ceil((r.lockedUntil - Date.now()) / 1000));
    const wait = seconds < 90 ? `${seconds} seconds` : seconds < 5400 ? `${Math.ceil(seconds / 60)} minutes` : `${Math.ceil(seconds / 3600)} hours`;
    return json({ error: `too many wrong PINs: try again in ${wait}`, lockedUntil: r.lockedUntil }, 429, { 'retry-after': String(seconds) });
  }

  async function pinRoutes(req: Request, url: URL, me: Caller, gate: { gated: boolean; locked: boolean }, unlockSecret: string | null): Promise<Response> {
    const [, a, b] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;
    const pin = inbox.pin;
    const status = () => ({ ...pin.status(), unlocked: !gate.locked, exempt: !gate.gated });
    if (a === 'pin' && !b && method === 'GET') return json(status());
    if (a === 'unlock' && !b && method === 'POST') {
      if (!pin.isSet()) return json({ error: 'this inbox has no PIN' }, 409);
      const body = (await readJson<{ key?: unknown } | null>(req, BODY_LIMIT.open)) ?? {};
      if (!validKey(body.key)) return json({ error: KEY_HELP }, 400);
      const r = await pin.unlock(body.key, me.token);
      return r.ok ? json({ unlock: r.token, idleMs: UNLOCK_IDLE_MS }) : refused(r);
    }
    if (a === 'lock' && !b && method === 'POST') {
      if (unlockSecret) await pin.lock(unlockSecret);
      return json({ ok: true });
    }
    if (a === 'pin' && b === 'never-ask' && method === 'PUT') {
      if (gate.locked) return json({ error: 'this inbox is locked: type its PIN to open it', locked: true }, 423);
      const body = (await readJson<{ neverAsk?: unknown } | null>(req, BODY_LIMIT.open)) ?? {};
      if (typeof body.neverAsk !== 'boolean') return json({ error: 'neverAsk must be true or false' }, 400);
      pin.setNeverAsk(body.neverAsk);
      return json(status());
    }
    if (a === 'pin' && !b && (method === 'PUT' || method === 'DELETE')) {
      const body = (await readJson<Partial<PinKey> & { current?: unknown } | null>(req, BODY_LIMIT.open)) ?? {};
      const error = method === 'PUT' ? pinKeyError(body, pin.iterations) : undefined;
      if (error) return json({ error }, 400);
      // The page proves it knows the PIN it changes. A token kept on this machine, such as the owner-token file, resets a forgotten one.
      if (pin.isSet() && gate.gated) {
        if (!validKey(body.current)) return json({ error: 'send the current PIN\'s key to change it, or reset it on the computer that runs the inbox: your-attention pin reset' }, 403);
        const r = await pin.check(body.current);
        if (!r.ok) return refused(r);
      }
      if (method === 'PUT') await pin.setKey({ key: String(body.key), salt: String(body.salt), iterations: Number(body.iterations) });
      else pin.clear();
      // The tab that changed the PIN stays unlocked. Every other tab types the new one.
      const unlock = method === 'PUT' && gate.gated ? await pin.issue(me.token) : undefined;
      return json({ ...status(), unlocked: true, ...(unlock ? { unlock } : {}) });
    }
    return json({ error: 'not found' }, 404);
  }

  /** A revised card, with the warning for the agent when the person won't see the revision. */
  const withWarning = (card: Card): Card & { warning?: string } => {
    const warning = inbox.revisionWarning(card.id);
    return warning ? { ...card, warning } : card;
  };

  async function routeAuthed(req: Request, url: URL, me: Caller, gate: { gated: boolean; locked: boolean; unlock?: string }): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [, a, b, c] = parts;
    const method = req.method;
    const owner = (): void => {
      if (me.role !== 'owner') throw new InboxError(403, 'only the owner can do this');
    };

    if (method === 'GET' && a === 'state') { owner(); return json(inbox.summaryState()); }
    if (method === 'POST' && a === 'archive' && !b) return json(inbox.archive(me));
    if (method === 'POST' && a === 'sign-in-codes' && !b) return json(inbox.createSignInCode(me), 201);
    if (method === 'GET' && a === 'addresses' && !b) { owner(); return json({ addresses: options.networkAddresses?.() ?? [] }); }
    if (method === 'POST' && a === 'focus' && !b) {
      owner();
      const { href } = (await readJson<{ href?: string } | null>(req, BODY_LIMIT.open)) ?? {};
      if (typeof href !== 'string' || !parseSessionLink(href)) return json({ error: 'not a session link' }, 400);
      if (!options.focusSession) return json({ error: 'this inbox cannot open sessions' }, 501);
      try { await options.focusSession(href); } catch { return json({ error: 'herdr could not open that session' }, 502); }
      return json({ ok: true });
    }
    if (method === 'POST' && a === 'reset' && !b) {
      // A reset cannot be undone, so the request must say so.
      if ((await readJson<{ confirm?: string }>(req)).confirm !== 'reset') throw new InboxError(400, 'send {"confirm": "reset"} to remove every card');
      return json(await inbox.reset(me));
    }
    if (options.streams === false && method === 'GET' && (a === 'events' || a === 'stream' || a === 'poll')) {
      return json({ error: 'this inbox serves events over the WebSocket at /v1/ws only' }, 410);
    }
    if (method === 'GET' && a === 'events') {
      owner();
      return eventStream((send, end) => {
        send('beat', { type: 'beat', at: Date.now() });
        return inbox.subscribePage((ev) => send(ev.type, ev), url.searchParams.get('viewer') ?? undefined, gate.gated ? { unlock: gate.unlock, close: end } : undefined);
      }, heartbeatMs);
    }
    if (method === 'GET' && a === 'poll') {
      // Long-poll for clients that cannot keep a stream: returns at the first answer, or after `wait` seconds.
      const agent = url.searchParams.get('agent');
      if (!agent) return json({ error: 'agent is required' }, 400);
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 25), 0), 55) * 1000;
      const events: AgentEvent[] = [];
      let wake: () => void = () => {};
      const woken = new Promise<void>((r) => { wake = r; });
      const channelOff = url.searchParams.get('channel') === 'off';
      const disconnect = inbox.connect(me, agent, (ev) => { if (ev.type !== 'hello') { events.push(ev); wake(); } }, url.searchParams.get('instance') ?? undefined, { channelOff });
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A client that drops its connection ends the wait at once, so the inbox lets go of its subscriber and its timer.
      const gone = req.signal.aborted ? Promise.resolve() : new Promise<void>((r) => req.signal.addEventListener('abort', () => r(), { once: true }));
      if (!events.length) await Promise.race([woken, gone, new Promise<void>((r) => { timer = setTimeout(r, wait); })]);
      if (timer !== undefined) clearTimeout(timer);
      disconnect();
      return json({ events });
    }
    if (a === 'person') {
      if (me.role === 'agent') throw new InboxError(403, 'only the owner and extensions read where the person is');
      if (method === 'GET') return json(inbox.person());
      if (method === 'POST' && b) { owner(); return json(inbox.reportViewer(b, await readJson<{ visible?: boolean; active?: boolean; focus?: string | null }>(req))); }
    }
    if (method === 'GET' && a === 'stream') {
      const agent = url.searchParams.get('agent');
      if (!agent) return json({ error: 'agent is required' }, 400);
      return eventStream((send) => inbox.connect(me, agent, (ev) => send(ev.type, ev), url.searchParams.get('instance') ?? undefined, { channelOff: url.searchParams.get('channel') === 'off' }), heartbeatMs);
    }
    if (method === 'GET' && a === 'search') return json(inbox.search(url.searchParams.get('q') ?? '', Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100), url.searchParams.get('answered') === '1'));
    if (method === 'GET' && a === 'unread') return json(inbox.unread(me, url.searchParams.get('agent') ?? undefined));
    if (method === 'GET' && a === 'dead-letters') return json(inbox.deadLetters());
    if (a === 'templates') {
      if (method === 'GET' && !b) return json(inbox.listTemplates());
      if (method === 'GET' && b) return json(inbox.getTemplate(b));
      if (method === 'POST' && !b) {
        if (me.role === 'extension') throw new InboxError(403, 'extensions cannot change templates');
        const t = await readJson<{ name?: string; source?: string; feedback?: string }>(req);
        return json(inbox.saveTemplate(String(t.name ?? ''), String(t.source ?? ''), t.feedback), 201);
      }
    }
    if (a === 'widgets') {
      if (method === 'GET' && !b) return json(inbox.listWidgets());
      if (method === 'GET' && b) return json(inbox.getWidget(b));
      if (method === 'POST' && !b) {
        if (me.role === 'extension') throw new InboxError(403, 'extensions cannot change widgets');
        const w = await readJson<{ name?: string; source?: string; feedback?: string; when?: string; response?: string }>(req);
        return json(inbox.saveWidget(String(w.name ?? ''), String(w.source ?? ''), w.feedback, { when: w.when, response: w.response }), 201);
      }
    }
    if (a === 'priorities') {
      if (method === 'GET') return json(inbox.priorities());
      if (method === 'PUT') {
        if (me.role === 'extension') throw new InboxError(403, 'extensions cannot change priority levels');
        // The owner changes them at once. An agent proposes them, and the person approves on a system card.
        if (me.role === 'owner') return json(inbox.setPriorities(await readJson<PriorityLevel[]>(req)));
        return json({ proposed: publicCard(inbox.proposePriorities(await readJson<PriorityLevel[]>(req))) }, 202);
      }
    }
    if (a === 'guidance') {
      if (method === 'GET') return json({ ...inbox.guidance(), widgets: inbox.widgetCatalog(), tags: inbox.tagsInUse() });
      if (method === 'POST') {
        const g = await readJson<{ text?: string; agent?: string }>(req);
        return json(publicCard(inbox.proposeGuidance(String(g.text ?? ''), g.agent ? { caller: me, agent: String(g.agent) } : undefined)), 201);
      }
    }
    if (a === 'telemetry' && !b && (method === 'GET' || method === 'PUT')) {
      owner();
      const t = options.telemetry;
      if (!t) return json({ error: 'this inbox sends no usage counts' }, 404);
      if (method === 'PUT') {
        const body = (await readJson<{ enabled?: unknown; notified?: unknown; resetId?: unknown } | null>(req, BODY_LIMIT.open)) ?? {};
        for (const k of ['enabled', 'notified', 'resetId'] as const) {
          if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new InboxError(400, `${k} must be true or false`);
        }
        const enabled = body.enabled as boolean | undefined;
        if (enabled === false && inbox.usage.settings().alwaysOn) throw new InboxError(400, 'a hosted inbox always sends usage counts');
        // Turning it on or off means the person read what it sends.
        inbox.usage.update({ enabled, notified: enabled !== undefined || body.notified === true ? true : undefined, resetId: body.resetId === true });
      }
      const s = inbox.usage.settings();
      const blocked = t.blocked?.() ?? null;
      // A laptop offers the counts once. A hosted inbox tells the person once that they are always on.
      return json({ ...s, notice: !s.notified && !blocked, blocked, source: t.source, destination: t.destination, next: inbox.usage.report(inbox.usage.today(), t.source) });
    }
    if (a === 'settings') {
      if (method === 'GET') return json(inbox.settings());
      if (method === 'PUT') { owner(); return json(inbox.setSettings(await readJson<Partial<Settings>>(req))); }
    }
    if (method === 'GET' && a === 'extensions' && b === 'stream') {
      const reg = {
        name: url.searchParams.get('name') ?? '',
        hooks: (url.searchParams.get('hooks') ?? '').split(',').filter(Boolean) as HookName[],
        timeoutMs: Number(url.searchParams.get('timeoutMs') ?? 0) || undefined,
        policy: (url.searchParams.get('policy') ?? 'fail-open') as FailurePolicy,
      };
      // Validate before the stream opens, so a bad registration gets a plain error.
      inbox.checkExtension(me, reg);
      return eventStream((send) => inbox.connectExtension(me, reg, (ev) => send(ev.type, ev)), heartbeatMs);
    }
    if (method === 'POST' && a === 'hooks' && b) {
      const v = await readJson<{ verdict?: Verdict; reason?: string }>(req);
      return json(publicCard(inbox.hookVerdict(me, b, v.verdict as Verdict, String(v.reason ?? ''))));
    }
    if (a === 'webhooks') {
      owner();
      if (method === 'GET') return json(inbox.listWebhooks());
      if (method === 'POST') {
        const w = await readJson<{ hook?: string; url?: string }>(req);
        const secret = randomId(24);
        const hook = inbox.addWebhook(String(w.hook ?? ''), String(w.url ?? ''), secret);
        return json({ ...hook, secret }, 201);
      }
      if (method === 'DELETE' && b) { inbox.deleteWebhook(b); return json({ ok: true }); }
    }
    if (a === 'subscriptions') {
      if (method === 'GET' && !b) return json(inbox.listSubscriptions(me));
      if (method === 'DELETE' && b) { inbox.deleteSubscription(me, b); return json({ ok: true }); }
    }
    if (method === 'GET' && a === 'attachments' && b) {
      const { file, bytes } = await inbox.attachment(me, b);
      // Only types a browser renders go inline, HTML in a sandbox that runs no script. Everything else downloads.
      const type = attachmentType(file);
      const inline = INLINE_TYPES.has(type) && url.searchParams.get('download') !== '1';
      return new Response(bytes, { headers: fileHeaders(INLINE_TYPES.has(type) ? type : 'application/octet-stream', inline, file.name, 'private, max-age=86400') });
    }
    if (method === 'GET' && a === 'tokens') { owner(); return json(inbox.listTokens()); }
    if (method === 'DELETE' && a === 'tokens' && b) { owner(); inbox.revokeToken(b); return json({ ok: true }); }

    // The default tags an agent's cards inherit. A token reads and writes only its own, and the owner lists them all.
    if (a === 'tags' && !b) {
      if (method === 'GET') {
        if (me.role === 'owner') return json({ defaults: inbox.defaultTagsList(me, url.searchParams.get('agent') ?? undefined) });
        if (me.role !== 'agent') throw new InboxError(403, 'only an agent reads its own default tags');
        const agent = url.searchParams.get('agent');
        if (!agent) return json({ error: 'agent is required' }, 400);
        return json(inbox.defaultTags(me, agent));
      }
      if (method === 'PUT') return json(inbox.setDefaultTags(me, await readJson(req)));
    }

    if (method === 'POST' && a === 'preview' && !b) return json(inbox.preview(me, await readJson<Parameters<Inbox['preview']>[1]>(req)));
    if (a === 'cards') {
      if (method === 'POST' && !b) {
        const input = await readJson<NewCard>(req, BODY_LIMIT.card);
        // A system card from a client asks the inbox for something, and the answer says what the inbox did.
        if (input?.kind === 'system') {
          const done = inbox.systemRequest(me, input);
          return 'secret' in done ? json(done, 201, { [ONCE_HEADER]: '1' }) : json(done, 200);
        }
        const card = await inbox.postCardWithFiles(me, input);
        // The reply names the tags the card took from the agent's defaults, so the agent knows what it inherited.
        return json({ ...withWarning(publicCard(card)), inheritedTags: inbox.inheritedTags(me, input) }, 201);
      }
      if (method === 'GET' && !b) return json(inbox.listCards(me));
      if (!b) return json({ error: 'not found' }, 404);
      if (method === 'GET' && !c) {
        const card = inbox.getCard(b);
        if (me.role !== 'owner' && card.token !== me.token) throw new InboxError(403, 'another client owns this card');
        const detail = inbox.cardDetail(b, me.role === 'owner');
        return json(me.role === 'owner' && servesFiles(card) ? { ...detail, card: { ...detail.card, localFiles: true } } : detail);
      }
      if (method === 'GET' && c === 'file') {
        owner();
        // With a PIN, a cookie alone never opens a file: the tab needs a ticket from an unlocked page.
        if (gate.gated && inbox.pin.isSet()) throw new InboxError(403, 'open this file from its card');
        const name = url.searchParams.get('path') ?? '';
        await cardFile(inbox.getCard(b), name);
        // The file opens at its folder ticket's address, where the relative addresses of its images and styles resolve.
        const t = folderTicket(b, name, me, gate);
        return new Response(null, { status: 303, headers: { location: `../../files/${t.id}/${encodeURIComponent(t.name)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      }
      if (method !== 'POST') return json({ error: 'not found' }, 404);
      const body = await readJson<Record<string, unknown>>(req, c === 'answer' ? BODY_LIMIT.card : BODY_LIMIT.other);
      switch (c) {
        case 'file-ticket': {
          owner();
          const path = String(body['path'] ?? '');
          await cardFile(inbox.getCard(b), path);
          const t = folderTicket(b, path, me, gate);
          return json({ ticket: t.id, name: t.name }, 201);
        }
        case 'answer': {
          owner();
          const saved = await inbox.answer(b, {
            images: body['images'] as Parameters<Inbox['answer']>[1]['images'],
            values: body['values'] as Record<string, unknown> | undefined,
            comment: body['comment'] as string | undefined,
            delivery: body['delivery'] as Delivery | undefined,
            version: body['version'] as number | undefined,
          });
          // The owner's answer types each approval it turned on into its pane, and the reply says how each went.
          return json((await inbox.sendApprovals(me, b)) ?? saved);
        }
        case 'close':
          return json(publicCard(inbox.close(me, b, body['kind'] as CloseKind, String(body['outcome'] ?? ''), body['ifUnanswered'] === true)));
        case 'dismiss':
          owner();
          return json(publicCard(inbox.dismiss(me, b, { values: body['values'], comment: body['comment'] })));
        case 'reply':
          return json(publicCard(inbox.reply(me, b, String(body['text'] ?? ''))));
        case 'ack':
          return json(inbox.ack(me, b));
        case 'patch':
          return json(withWarning(publicCard(await inbox.patchCardChecked(me, b, body['edits'] as { old: string; new: string }[], body['field'] as string | undefined))));
        case 'status':
          return json(publicCard(inbox.setStatus(me, b, String(body['status'] ?? ''))));
        case 'claim':
          return json(publicCard(inbox.claim(me, b, String(body['agent'] ?? ''))));
        case 'seen':
          owner(); inbox.seen(b); return json({ ok: true });
        case 'draw-fault':
          return json(publicCard(inbox.drawFault(me, b, body)));
        case 'force':
          owner(); return json(inbox.force(b));
        case 'release':
          owner(); return json(publicCard(inbox.release(b)));
        case 'open': {
          owner();
          if (!options.openOrigin) return json({ error: 'this inbox cannot open sessions' }, 501);
          await options.openOrigin(inbox.getCard(b));
          return json({ ok: true });
        }
      }
    }
    return json({ error: 'not found' }, 404);
  }

  return async (req) => {
    try {
      return await route(req);
    } catch (e) {
      if (e instanceof InboxError) return json({ error: e.message }, e.status);
      return json({ error: 'internal error' }, 500);
    }
  };
}
