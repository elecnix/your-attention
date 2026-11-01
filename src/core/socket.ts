// One agent connection over a WebSocket, for any platform. The platform calls
// `message` for each text frame and `close` when the socket closes.
//
// Client to inbox: {type: "auth", token} first when the client cannot send an
// Authorization header, then {type: "ack", card} and {type: "ping"}.
// Inbox to client: the same events as the stream, and {type: "pong"}.
import type { Caller, Inbox } from './inbox.ts';

/** The frames a socket may send in a minute. A socket past it closes, since each frame wakes the inbox. */
export const FRAMES_PER_MINUTE = 120;

/** Counts a socket's frames in the current minute. */
function frameBudget(now: () => number = Date.now): () => boolean {
  let start = now();
  let count = 0;
  return () => {
    if (now() - start >= 60_000) { start = now(); count = 0; }
    return ++count <= FRAMES_PER_MINUTE;
  };
}

export interface SocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface AgentSocket {
  message(text: string): Promise<void>;
  close(): void;
  readonly authenticated: boolean;
  /** The client, once it authenticated, so a platform can keep it with a hibernating socket. */
  readonly caller: Caller | undefined;
}

/** `resumed` marks a socket that was already open and signed in before the platform rebuilt it, as a Durable Object does
 * when it wakes: the client keeps the same connection, so it gets no second `hello`. */
export function agentSocket(inbox: Inbox, agent: string, ws: SocketLike, caller?: Caller, instance?: string, resumed = false): AgentSocket {
  let me = caller;
  let disconnect: (() => void) | undefined;
  const allow = frameBudget();
  const start = (c: Caller, quiet: boolean): void => {
    me = c;
    disconnect = inbox.connect(c, agent, (ev) => ws.send(JSON.stringify(ev)), instance, { resumed: quiet });
  };
  if (me) start(me, resumed);
  return {
    async message(text) {
      if (!allow()) return ws.close(4429, `more than ${FRAMES_PER_MINUTE} frames a minute`);
      let msg: { type?: string; token?: string; card?: string } | null;
      try { msg = JSON.parse(text) as typeof msg; } catch { return ws.close(1003, 'frames must be JSON'); }
      if (!msg || typeof msg !== 'object') return ws.close(1003, 'frames must be JSON objects');
      if (!me) {
        const token = msg.type === 'auth' ? await inbox.authenticate(msg.token) : undefined;
        if (!token) return ws.close(4401, 'send {type: "auth", token} first');
        return start({ token: token.id, role: token.role }, false);
      }
      if (msg.type === 'ping') return ws.send('{"type":"pong"}');
      if (msg.type === 'ack' && msg.card) {
        try { inbox.ack(me, msg.card); } catch (e) { ws.send(JSON.stringify({ type: 'error', error: (e as Error).message })); }
      }
    },
    close() {
      disconnect?.();
      disconnect = undefined;
    },
    get authenticated() {
      return me !== undefined;
    },
    get caller() {
      return me;
    },
  };
}

/** The inbox page over a WebSocket, for the owner: the same events as GET /v1/events. The page sends {type: "ping"} and gets {type: "pong"}.
 * A page that signed in with a cookie or a link token passes `guard`, with the unlock token it opened with, so the socket closes when the PIN changes. */
export function pageSocket(inbox: Inbox, ws: SocketLike, viewer?: string, guard?: { unlock: string | undefined }): { message(text: string): void; close(): void } {
  const allow = frameBudget();
  const stop = inbox.subscribePage((ev) => ws.send(JSON.stringify(ev)), viewer, guard ? { unlock: guard.unlock, close: () => ws.close(4423, 'the PIN changed: unlock again') } : undefined);
  return {
    message(text) {
      if (!allow()) return ws.close(4429, `more than ${FRAMES_PER_MINUTE} frames a minute`);
      if (text.includes('"ping"')) ws.send('{"type":"pong"}');
    },
    close: stop,
  };
}
