// One inbox as one Durable Object. All its changes go through this object one
// at a time, and it hibernates when idle: agent sockets stay open, and the
// object rebuilds each connection from the socket's attachment when it wakes.
import { createHandler } from '../core/http.ts';
import { Inbox } from '../core/inbox.ts';
import { agentSocket, type AgentSocket } from '../core/socket.ts';
import type { Role } from '../core/types.ts';
import { DurableSqlStorage, R2Blobs } from './storage.ts';
import type { Env } from './worker.ts';

/** What each agent socket keeps across hibernation. */
interface SocketAttachment {
  agent: string;
  token?: string;
  role?: Role;
  /** When the socket opened, the start of its heartbeat clock until its first ping. */
  connectedAt?: number;
}

/** A socket closes when it has not answered a heartbeat for this long. */
const HEARTBEAT_LIMIT_MS = 60_000;
/** How often the alarm checks heartbeats while agent sockets are open. */
const HEARTBEAT_CHECK_MS = 30_000;

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
  private readonly sockets = new Map<WebSocket, AgentSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.inbox = new Inbox(new DurableSqlStorage(ctx.storage.sql), Date.now, new R2Blobs(env.FILES, ctx.id.toString()), { keepPresence: true });
    this.handle = createHandler(this.inbox, { heartbeatMs: 2000 });
    // Heartbeats get their answer without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    for (const ws of ctx.getWebSockets()) this.attach(ws);
  }

  private attach(ws: WebSocket): AgentSocket {
    const a = ws.deserializeAttachment() as SocketAttachment;
    const caller = a.token && a.role ? { token: a.token, role: a.role } : undefined;
    const conn = agentSocket(this.inbox, a.agent, { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) }, caller);
    this.sockets.set(ws, conn);
    return conn;
  }

  private async schedule(): Promise<void> {
    const next = this.inbox.nextDeadline();
    const heartbeat = this.ctx.getWebSockets().length ? Date.now() + HEARTBEAT_CHECK_MS : undefined;
    const at = [next, heartbeat].filter((x): x is number => x !== undefined);
    if (at.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...at), Date.now() + 50));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/_init') {
      // The Worker calls this once per inbox. The object is never reachable from outside without the Worker.
      const { ownerToken } = (await req.json()) as { ownerToken?: string };
      if (ownerToken) {
        if (!(await this.inbox.authenticate(ownerToken))) await this.inbox.adoptToken(ownerToken, 'owner from the deployment', 'owner');
        return Response.json({ ok: true });
      }
      const { secret } = await this.inbox.createToken('owner of this hosted inbox', 'owner');
      return Response.json({ owner: secret });
    }
    if (url.pathname === '/v1/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const agent = url.searchParams.get('agent');
      if (!agent) return new Response('agent is required', { status: 400 });
      const auth = req.headers.get('authorization');
      const token = auth?.startsWith('Bearer ') ? await this.inbox.authenticate(auth.slice(7).trim()) : undefined;
      if (auth && !token) return new Response('unknown token', { status: 401 });
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ agent, token: token?.id, role: token?.role, connectedAt: Date.now() } satisfies SocketAttachment);
      this.attach(server);
      await this.schedule();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const res = await this.handle(req);
    await this.schedule();
    return res;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const conn = this.sockets.get(ws) ?? this.attach(ws);
    const before = conn.authenticated;
    await conn.message(typeof message === 'string' ? message : new TextDecoder().decode(message));
    // A client that authenticated in its first frame keeps that across hibernation.
    if (!before && conn.caller) {
      const a = ws.deserializeAttachment() as SocketAttachment;
      ws.serializeAttachment({ ...a, token: conn.caller.token, role: conn.caller.role } satisfies SocketAttachment);
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
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? (ws.deserializeAttachment() as SocketAttachment).connectedAt ?? now;
      if (now - last > HEARTBEAT_LIMIT_MS) {
        this.sockets.get(ws)?.close();
        this.sockets.delete(ws);
        ws.close(1001, 'missed heartbeats');
      }
    }
    await this.schedule();
  }
}
