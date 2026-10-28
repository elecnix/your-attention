// The HTTP protocol, with fetch Request and Response only, so the same handler
// runs on Node, Bun, Deno and Workers. SPEC.md lists each route.
import { randomId } from './crypto.ts';
import type { FailurePolicy, HookName, Verdict } from './hooks.ts';
import { Inbox, InboxError, publicCard, type Caller } from './inbox.ts';
import type { AgentEvent, Card, CloseKind, Delivery, NewCard, PriorityLevel, Role, Settings, Token } from './types.ts';
import { PROTOCOL_VERSION } from './types.ts';

export const COOKIE = 'ya_token';
/** Cookie-authenticated writes must carry this header, which a cross-site form cannot set. */
export const CSRF_HEADER = 'x-your-attention';
/** A client-chosen id that makes a write idempotent across links and retries. */
export const MESSAGE_HEADER = 'x-message-id';
/** File types the page shows in place. Any other file is served as a download. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);

export interface HandlerOptions {
  /** Opens the session a card came from, such as a herdr pane. */
  openOrigin?: (card: Card) => Promise<void>;
  /** Milliseconds between keep-alive lines on a stream. */
  heartbeatMs?: number;
  /** Whether to serve the event stream, agent streams and long-polls. A platform that bills for open requests turns them off and serves WebSockets only. */
  streams?: boolean;
  /** Where a device on the same network reaches this inbox, such as http://laptop.local:4815. */
  networkAddresses?: () => string[];
}

/** The largest body each kind of route reads. A card post carries its files as data: URLs. */
const BODY_LIMIT = { open: 4096, card: 16_000_000, other: 1_000_000 };

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
      if (beat !== undefined) clearInterval(beat);
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
    if (method === 'GET' && a === 'info') return json({ name: 'your-attention', protocol: PROTOCOL_VERSION, id: inbox.id(), pair: '/v1/pair' });
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
    const me: Caller = { token: who.token.id, role: who.token.role };
    // A full inbox takes the writes that free space or answer cards, and refuses the rest.
    const frees = method === 'DELETE' || (method === 'POST' && (a === 'reset' || a === 'archive' || a === 'logout' || a === 'person' || c === 'close' || c === 'answer'));
    if (method !== 'GET' && !frees && inbox.storageFull()) return json({ error: 'this inbox is full: remove cards, templates or widgets to make room' }, 507);
    // A message that arrives over two links, or again after a retry, is applied once: the inbox
    // keeps the first result for each x-message-id, per client.
    const messageId = method === 'GET' ? null : req.headers.get(MESSAGE_HEADER);
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
        res = await routeAuthed(req, url, me);
      } catch (e) {
        inbox.forgetMessage(key);
        throw e;
      }
      if (res.status < 500 && (res.headers.get('content-type') ?? '').startsWith('application/json')) inbox.rememberMessage(key, res.status, await res.clone().text());
      else inbox.forgetMessage(key);
      return res;
    }
    return routeAuthed(req, url, me);
  }

  async function routeAuthed(req: Request, url: URL, me: Caller): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [, a, b, c] = parts;
    const method = req.method;
    const owner = (): void => {
      if (me.role !== 'owner') throw new InboxError(403, 'only the owner can do this');
    };

    if (method === 'GET' && a === 'state') { owner(); return json(inbox.state()); }
    if (method === 'POST' && a === 'archive' && !b) return json(inbox.archive(me));
    if (method === 'POST' && a === 'sign-in-codes' && !b) return json(inbox.createSignInCode(me), 201);
    if (method === 'GET' && a === 'addresses' && !b) { owner(); return json({ addresses: options.networkAddresses?.() ?? [] }); }
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
      return eventStream((send) => {
        send('beat', { type: 'beat', at: Date.now() });
        return inbox.subscribePage((ev) => send(ev.type, ev), url.searchParams.get('viewer') ?? undefined);
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
      const disconnect = inbox.connect(me, agent, (ev) => { if (ev.type !== 'hello') { events.push(ev); wake(); } }, url.searchParams.get('instance') ?? undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!events.length) await Promise.race([woken, new Promise<void>((r) => { timer = setTimeout(r, wait); })]);
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
      return eventStream((send) => inbox.connect(me, agent, (ev) => send(ev.type, ev), url.searchParams.get('instance') ?? undefined), heartbeatMs);
    }
    if (method === 'GET' && a === 'search') return json(inbox.search(url.searchParams.get('q') ?? '', Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100), url.searchParams.get('answered') === '1'));
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
        const w = await readJson<{ name?: string; source?: string; feedback?: string }>(req);
        return json(inbox.saveWidget(String(w.name ?? ''), String(w.source ?? ''), w.feedback), 201);
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
      if (method === 'GET') return json(inbox.guidance());
      if (method === 'POST') return json(publicCard(inbox.proposeGuidance(String((await readJson<{ text?: string }>(req)).text ?? ''))), 201);
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
    if (method === 'GET' && a === 'attachments' && b) {
      const { file, bytes } = await inbox.attachment(me, b);
      // Only types the page renders go inline. Everything else downloads, and nothing served here runs scripts.
      const inline = INLINE_TYPES.has(file.type) && url.searchParams.get('download') !== '1';
      const name = encodeURIComponent(file.name);
      return new Response(bytes, {
        headers: {
          'content-type': INLINE_TYPES.has(file.type) ? file.type : 'application/octet-stream',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
          // Browsers refuse to show a PDF in a sandboxed document, so a PDF gets the other limits without sandbox.
          'content-security-policy': `${file.type === 'application/pdf' ? '' : 'sandbox; '}default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=86400',
        },
      });
    }
    if (method === 'GET' && a === 'tokens') { owner(); return json(inbox.listTokens()); }
    if (method === 'DELETE' && a === 'tokens' && b) { owner(); inbox.revokeToken(b); return json({ ok: true }); }

    if (a === 'cards') {
      if (method === 'POST' && !b) return json(publicCard(await inbox.postCardWithFiles(me, await readJson<NewCard>(req, BODY_LIMIT.card))), 201);
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
        case 'patch':
          return json(publicCard(inbox.patchCard(me, b, body['edits'] as { old: string; new: string }[], body['field'] as string | undefined)));
        case 'status':
          return json(publicCard(inbox.setStatus(me, b, String(body['status'] ?? ''))));
        case 'claim':
          return json(publicCard(inbox.claim(me, b, String(body['agent'] ?? ''))));
        case 'seen':
          owner(); inbox.seen(b); return json({ ok: true });
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
