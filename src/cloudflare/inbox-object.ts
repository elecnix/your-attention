// One inbox as one Durable Object. All its changes go through this object one
// at a time, and it hibernates when idle: agent sockets stay open, and the
// object rebuilds each connection from the socket's attachment when it wakes.
import { COOKIE, createHandler } from '../core/http.ts';
import { Inbox } from '../core/inbox.ts';
import { pinKeyError, type PinKey } from '../core/pin.ts';
import { agentSocket, pageSocket, type AgentSocket } from '../core/socket.ts';
import { dataPoint } from '../core/telemetry.ts';
import type { Role } from '../core/types.ts';
import { DurableSqlStorage, R2Blobs } from './storage.ts';
import type { Env } from './worker.ts';

/** What each agent socket keeps across hibernation. */
interface SocketAttachment {
  /** Set for the inbox page's socket, which carries page events. */
  page?: boolean;
  viewer?: string | undefined;
  /** A page that needs the PIN, and the id of the unlock token it opened with. */
  gated?: boolean;
  unlock?: string | undefined;
  agent: string;
  /** The agent process, the same across its reconnects. */
  instance?: string | undefined;
  token?: string;
  role?: Role;
  /** When the socket opened, the start of its heartbeat clock until its first ping. */
  connectedAt?: number;
}

/** An unset limit means none. A value that is not a byte count blocks every upload, so a typo never lifts the cap. */
export function uploadLimit(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** A socket closes when it has not answered a heartbeat for this long. */
const HEARTBEAT_LIMIT_MS = 60_000;
/** How often the alarm checks heartbeats while agent sockets are open. */
const HEARTBEAT_CHECK_MS = 30_000;
type Conn = AgentSocket | ReturnType<typeof pageSocket>;

/** A socket that has not signed in this long after it opened closes. */
const AUTH_LIMIT_MS = 10_000;
/** The most sockets one inbox keeps open. */
const MAX_SOCKETS = 64;

/** Read a numeric limit from the environment. */
function limit(value: string | undefined): number | undefined {
  return uploadLimit(value);
}

/** Redeems invite codes one at a time, so a code with one use left creates one inbox, however many requests race.
 * The operator sets the uses in KV; this object counts the uses taken. */
export class RegistryObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const { code } = (await req.json()) as { code?: string };
    const allowed = Number(await this.env.INVITES.get(`invite:${String(code ?? '')}`)) || 0;
    // Durable Object storage calls queue behind each other, so this read and write cannot interleave with another request's.
    const used = (await this.ctx.storage.get<number>(`used:${code}`)) ?? 0;
    if (!code || used >= allowed) return Response.json({ ok: false });
    await this.ctx.storage.put(`used:${code}`, used + 1);
    return Response.json({ ok: true, left: allowed - used - 1 });
  }
}

export class InboxObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly inbox: Inbox;
  private readonly handle: (req: Request) => Promise<Response>;
  private readonly sockets = new Map<WebSocket, Conn>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.inbox = new Inbox(new DurableSqlStorage(ctx.storage.sql), Date.now, new R2Blobs(env.FILES, ctx.id.toString()), {
      keepPresence: true,
      uploadLimitBytes: uploadLimit(env.UPLOAD_LIMIT_BYTES),
      storageLimitBytes: limit(env.STORAGE_LIMIT_BYTES),
      shownCardLimit: limit(env.SHOWN_CARDS_LIMIT),
      attachmentReadsPerDay: limit(env.ATTACHMENT_READS_PER_DAY),
      // A request gets 10 ms of CPU time on the Workers Free plan, too little to parse a large body or a diagram.
      // So the posting client checks them, and the page reports what it cannot draw. See SPEC.md, "Checks on the client".
      clientChecks: true,
      // The hosted service always counts usage. A single-inbox deployment sends nothing.
      usageAlwaysOn: env.MODE === 'hosted',
    });
    // Open requests keep the object awake and billed, so events go over hibernating WebSockets only.
    this.handle = createHandler(this.inbox, { heartbeatMs: 2000, streams: false, telemetry: { source: 'hosted', destination: 'the operator of this hosted service', blocked: () => this.usageBlocked() } });
    // Heartbeats get their answer without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    // Each socket here was open before the object hibernated, and its client already got its hello.
    for (const ws of ctx.getWebSockets()) this.attach(ws, true);
  }

  /** `resumed` is set for a socket the object rebuilds after waking, as opposed to one it just accepted. */
  private attach(ws: WebSocket, resumed = false): Conn {
    const a = ws.deserializeAttachment() as SocketAttachment;
    if (a.page) {
      const conn = pageSocket(this.inbox, { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) }, a.viewer, a.gated ? { unlock: a.unlock } : undefined);
      this.sockets.set(ws, conn);
      return conn;
    }
    const caller = a.token && a.role ? { token: a.token, role: a.role } : undefined;
    const conn = agentSocket(this.inbox, a.agent, { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) }, caller, a.instance, resumed);
    this.sockets.set(ws, conn);
    return conn;
  }

  /** Why this deployment sends no usage counts. Only the hosted service sends them, to its own operator. */
  private usageBlocked(): string | undefined {
    if (this.env.MODE !== 'hosted') return 'a single-inbox deployment sends nothing';
    if (!this.env.TELEMETRY) return 'this deployment has no usage dataset';
    return undefined;
  }

  /** Write each finished day to Analytics Engine. A hosted inbox always sends: its Usage reads as enabled whatever is stored. */
  private sendUsage(): void {
    const usage = this.inbox.usage;
    const due = usage.due();
    if (!due.length) return;
    const s = usage.settings();
    for (const d of due) {
      if (s.enabled && !this.usageBlocked()) this.env.TELEMETRY?.writeDataPoint(dataPoint(usage.report(d, 'hosted')));
      usage.done(d.day);
    }
  }

  private async schedule(): Promise<void> {
    this.sendUsage();
    const next = this.inbox.nextDeadline();
    const heartbeat = this.ctx.getWebSockets().length ? Date.now() + HEARTBEAT_CHECK_MS : undefined;
    const at = [next, heartbeat].filter((x): x is number => x !== undefined);
    if (at.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...at), Date.now() + 50));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/_init') {
      // The Worker calls this once per inbox. The object is never reachable from outside without the Worker.
      const { ownerToken, usage, pin, neverAsk } = (await req.json()) as { ownerToken?: string; usage?: { invite?: string }; pin?: PinKey; neverAsk?: boolean };
      // A hosted inbox learns its invite id here.
      if (usage) this.inbox.usage.update({ invite: String(usage.invite ?? '') });
      if (ownerToken) {
        try {
          if (!(await this.inbox.authenticate(ownerToken))) await this.inbox.adoptToken(ownerToken, 'owner from the deployment', 'owner');
        } catch (e) {
          return Response.json({ error: `the OWNER_TOKEN secret is wrong: ${(e as Error).message}` }, { status: 500 });
        }
        return Response.json({ ok: true });
      }
      // The Worker checked the key's form already. A key the object refuses creates no inbox.
      const pinError = pin === undefined ? undefined : pinKeyError(pin, this.inbox.pin.iterations);
      if (pinError) return Response.json({ error: `pin: ${pinError}` }, { status: 400 });
      const { token, secret } = await this.inbox.createToken('owner of this hosted inbox', 'owner');
      // The landing page set the PIN as it created the inbox, and the tab it opens in starts unlocked.
      if (neverAsk === true) this.inbox.pin.setNeverAsk(true);
      if (pin === undefined) return Response.json({ owner: secret });
      // The landing page derived the key. The object stores only its SHA-256.
      await this.inbox.pin.setKey(pin);
      return Response.json({ owner: secret, unlock: await this.inbox.pin.issue(token.id) });
    }
    if (url.pathname === '/v1/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('too many open sockets', { status: 503 });
      if (url.searchParams.get('page') === '1') {
        // The page signs in with its cookie, which the browser sends with the upgrade.
        const auth = req.headers.get('authorization');
        const secret = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : cookieValue(req.headers.get('cookie'), COOKIE);
        const token = await this.inbox.authenticate(secret);
        if (token?.role !== 'owner') return new Response('the page needs the owner token', { status: 401 });
        // A browser cannot set headers on a WebSocket, so the page sends its unlock token in the address.
        const gate = await this.inbox.pinGate(token, !auth?.startsWith('Bearer '), url.searchParams.get('unlock'));
        if (gate.locked) return new Response('this inbox is locked: type its PIN to open it', { status: 423 });
        const pair = new WebSocketPair();
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        const viewer = url.searchParams.get('viewer') ?? undefined;
        server.serializeAttachment({ page: true, viewer: viewer && /^[\w-]{4,64}$/.test(viewer) ? viewer : undefined, gated: gate.gated, unlock: gate.unlock, agent: '', token: token.id, role: token.role, connectedAt: Date.now() } satisfies SocketAttachment);
        this.attach(server);
        await this.schedule();
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      const agent = url.searchParams.get('agent');
      if (!agent || agent.length > 80) return new Response('agent is required, at most 80 characters', { status: 400 });
      const auth = req.headers.get('authorization');
      const token = auth?.startsWith('Bearer ') ? await this.inbox.authenticate(auth.slice(7).trim()) : undefined;
      if (auth && !token) return new Response('unknown token', { status: 401 });
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ agent, instance: url.searchParams.get('instance') ?? undefined, token: token?.id, role: token?.role, connectedAt: Date.now() } satisfies SocketAttachment);
      this.attach(server);
      await this.schedule();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const res = await this.handle(req);
    await this.schedule();
    return res;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const conn = this.sockets.get(ws) ?? this.attach(ws, true);
    const agent = 'caller' in conn ? conn : undefined;
    const before = agent?.authenticated ?? true;
    await conn.message(typeof message === 'string' ? message : new TextDecoder().decode(message));
    // A client that authenticated in its first frame keeps that across hibernation.
    if (!before && agent?.caller) {
      const a = ws.deserializeAttachment() as SocketAttachment;
      ws.serializeAttachment({ ...a, token: agent.caller.token, role: agent.caller.role } satisfies SocketAttachment);
    }
    await this.schedule();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sockets.get(ws)?.close();
    this.sockets.delete(ws);
    await this.schedule();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** The platform alarm: sweep the inbox, and close sockets that stopped answering heartbeats. */
  async alarm(): Promise<void> {
    this.inbox.sweep();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as SocketAttachment;
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? a.connectedAt ?? now;
      // A socket that answers pings but never signed in would stay open for free, so it gets a deadline.
      const unsigned = !a.token && now - (a.connectedAt ?? now) > AUTH_LIMIT_MS;
      if (unsigned || now - last > HEARTBEAT_LIMIT_MS) {
        this.sockets.get(ws)?.close();
        this.sockets.delete(ws);
        ws.close(1001, 'missed heartbeats');
      }
    }
    await this.schedule();
  }
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try { return decodeURIComponent(v.join('=')); } catch { return undefined; }
  }
  return undefined;
}
