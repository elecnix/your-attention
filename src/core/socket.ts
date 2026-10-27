// One agent connection over a WebSocket, for any platform. The platform calls
// `message` for each text frame and `close` when the socket closes.
//
// Client to inbox: {type: "auth", token} first when the client cannot send an
// Authorization header, then {type: "ack", card} and {type: "ping"}.
// Inbox to client: the same events as the stream, and {type: "pong"}.
import type { Caller, Inbox } from './inbox.ts';

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

export function agentSocket(inbox: Inbox, agent: string, ws: SocketLike, caller?: Caller): AgentSocket {
  let me = caller;
  let disconnect: (() => void) | undefined;
  const start = (c: Caller): void => {
    me = c;
    disconnect = inbox.connect(c, agent, (ev) => ws.send(JSON.stringify(ev)));
  };
  if (me) start(me);
  return {
    async message(text) {
      let msg: { type?: string; token?: string; card?: string } | null;
      try { msg = JSON.parse(text) as typeof msg; } catch { return ws.close(1003, 'frames must be JSON'); }
      if (!msg || typeof msg !== 'object') return ws.close(1003, 'frames must be JSON objects');
      if (!me) {
        const token = msg.type === 'auth' ? await inbox.authenticate(msg.token) : undefined;
        if (!token) return ws.close(4401, 'send {type: "auth", token} first');
        return start({ token: token.id, role: token.role });
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
