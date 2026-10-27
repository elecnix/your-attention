// The HTTP protocol, with fetch Request and Response only, so the same handler
// runs on Node, Bun, Deno and Workers. SPEC.md lists each route.
import { Inbox, InboxError, publicCard, type Caller } from './inbox.ts';
import type { Card, CloseKind, Delivery, NewCard, Role, Token } from './types.ts';
import { PROTOCOL_VERSION } from './types.ts';

export const COOKIE = 'ya_token';
/** Cookie-authenticated writes must carry this header, which a cross-site form cannot set. */
export const CSRF_HEADER = 'x-your-attention';

export interface HandlerOptions {
  /** Opens the session a card came from, such as a herdr pane. */
  openOrigin?: (card: Card) => Promise<void>;
  /** Milliseconds between keep-alive lines on a stream. */
  heartbeatMs?: number;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > 1_000_000) throw new InboxError(413, 'body over 1 MB');
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

/** A server-sent event stream that calls `stop` when the client goes away. */
function eventStream(start: (send: (event: string, data: unknown) => void) => () => void, heartbeatMs: number): Response {
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
      stop = start(send);
      beat = setInterval(() => send('beat', { type: 'beat', at: Date.now() }), heartbeatMs);
    },
    cancel() {
      clearInterval(beat);
      stop();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
}

export function createHandler(inbox: Inbox, options: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const heartbeatMs = options.heartbeatMs ?? 2000;

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
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1') return json({ error: 'not found' }, 404);
    const [, a, b, c] = parts;
    const method = req.method;

    // Routes open to any client on the network.
    if (method === 'GET' && a === 'info') return json({ name: 'your-attention', protocol: PROTOCOL_VERSION, pair: '/v1/pair' });
    if (method === 'POST' && a === 'pair' && !b) {
      const body = await readJson<{ name?: string; role?: Role }>(req);
      const p = inbox.requestPairing(String(body.name ?? ''), body.role ?? 'agent');
      return json({ id: p.id, code: p.code }, 201);
    }
    if (method === 'GET' && a === 'pair' && b) return json(inbox.collectPairing(b));
    if (method === 'POST' && a === 'login') {
      const { token } = await readJson<{ token?: string }>(req);
      const t = await inbox.authenticate(token);
      if (!t || t.role !== 'owner') return json({ error: 'not an owner token' }, 401);
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${encodeURIComponent(String(token))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}` });
    }

    const who = await caller(req);
    if (!who) return json({ error: 'pair first: POST /v1/pair' }, 401);
    if (who.viaCookie && method !== 'GET' && req.headers.get(CSRF_HEADER) !== '1') return json({ error: `missing ${CSRF_HEADER} header` }, 403);
    const me: Caller = { token: who.token.id, role: who.token.role };
    const owner = (): void => {
      if (me.role !== 'owner') throw new InboxError(403, 'only the owner can do this');
    };

    if (method === 'GET' && a === 'state') { owner(); return json(inbox.state()); }
    if (method === 'GET' && a === 'events') {
      owner();
      return eventStream((send) => {
        send('beat', { type: 'beat', at: Date.now() });
        return inbox.subscribePage((ev) => send(ev.type, ev));
      }, heartbeatMs);
    }
    if (method === 'GET' && a === 'stream') {
      const agent = url.searchParams.get('agent');
      if (!agent) return json({ error: 'agent is required' }, 400);
      return eventStream((send) => inbox.connect(me, agent, (ev) => send(ev.type, ev)), heartbeatMs);
    }
    if (method === 'GET' && a === 'search') return json(inbox.search(url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 20)));
    if (method === 'GET' && a === 'dead-letters') return json(inbox.deadLetters());
    if (method === 'GET' && a === 'tokens') { owner(); return json(inbox.listTokens()); }
    if (method === 'DELETE' && a === 'tokens' && b) { owner(); inbox.revokeToken(b); return json({ ok: true }); }

    if (a === 'cards') {
      if (method === 'POST' && !b) return json(publicCard(inbox.postCard(me, await readJson<NewCard>(req))), 201);
      if (method === 'GET' && !b) return json(inbox.listCards(me));
      if (!b) return json({ error: 'not found' }, 404);
      if (method === 'GET' && !c) {
        const card = inbox.getCard(b);
        if (me.role !== 'owner' && card.token !== me.token) throw new InboxError(403, 'another client owns this card');
        return json({ card: publicCard(card), state: inbox.state().states[b] });
      }
      if (method !== 'POST') return json({ error: 'not found' }, 404);
      const body = await readJson<Record<string, unknown>>(req);
      switch (c) {
        case 'answer':
          owner();
          return json(await inbox.answer(b, {
            values: body['values'] as Record<string, unknown> | undefined,
            comment: body['comment'] as string | undefined,
            delivery: body['delivery'] as Delivery | undefined,
            version: body['version'] as number | undefined,
          }));
        case 'close':
          return json(publicCard(inbox.close(me, b, body['kind'] as CloseKind, String(body['outcome'] ?? ''), body['ifUnanswered'] === true)));
        case 'reply':
          return json(publicCard(inbox.reply(me, b, String(body['text'] ?? ''))));
        case 'ack':
          return json(inbox.ack(me, b));
        case 'claim':
          return json(publicCard(inbox.claim(me, b, String(body['agent'] ?? ''))));
        case 'seen':
          owner(); inbox.seen(b); return json({ ok: true });
        case 'force':
          owner(); return json(inbox.force(b));
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
