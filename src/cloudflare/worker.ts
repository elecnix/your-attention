// The Cloudflare build. MODE "single" serves one inbox, for a person who
// deploys their own. MODE "hosted" serves many: each inbox is created with an
// invite code, lives at an unguessable /i/<id>/ address, and is one Durable
// Object that hibernates when nobody uses it.
import { validPin } from '../core/pin.ts';
import { inviteId } from '../core/telemetry.ts';
import { InboxObject, RegistryObject } from './inbox-object.ts';

export interface Env {
  INBOX: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** Invite codes for the hosted service: "invite:<code>" holds the uses left. Inbox ids: "inbox:<id>". */
  INVITES: KVNamespace;
  MODE?: string;
  /** In single mode, the owner token, set with `wrangler secret put OWNER_TOKEN`. */
  OWNER_TOKEN?: string;
  /** The bytes of files each inbox may store over its life. */
  UPLOAD_LIMIT_BYTES?: string;
  /** The bytes each inbox may keep in its database. */
  STORAGE_LIMIT_BYTES?: string;
  /** The files each inbox may serve in a day. */
  ATTACHMENT_READS_PER_DAY?: string;
  /** In hosted mode, the key that signs inbox addresses, so the Worker checks an address without a KV read. */
  INBOX_ID_SECRET?: string;
  /** Counts signed-in API requests per inbox and client address. */
  LIMITER?: RateLimit;
  /** Counts requests without a token per client address: pairing, sign-in, and new inboxes. */
  ANON_LIMITER?: RateLimit;
  /** In hosted mode, where each inbox writes its daily usage counts. */
  TELEMETRY?: AnalyticsEngineDataset;
}

/** Invite codes shorter than this are refused before any lookup, so guessing one takes too long to try. */
const MIN_INVITE_LENGTH = 20;

const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const tooMany = (): Response => json({ error: 'too many requests, try again in a minute' }, 429);

/** Whether a request carries a token. The inbox checks the token; the Worker only picks the limiter. */
const signedIn = (req: Request): boolean => /^Bearer /.test(req.headers.get('authorization') ?? '') || /(^|;\s*)ya_token=/.test(req.headers.get('cookie') ?? '');
const clientAddress = (req: Request): string => req.headers.get('cf-connecting-ip') ?? 'unknown';

/** Count a request before it costs anything else. Signed-in calls count per inbox and address, so a stranger cannot use up the owner's budget. */
async function allowed(env: Env, req: Request, inbox: string): Promise<boolean> {
  const anon = !signedIn(req);
  const limiter = anon ? env.ANON_LIMITER : env.LIMITER;
  return !limiter || (await limiter.limit({ key: anon ? `anon:${clientAddress(req)}` : `${inbox}:${clientAddress(req)}` })).success;
}

/** Send a request to the inbox object, with the path the inbox expects. `prefix` is the inbox's own address, which its sign-in cookie is scoped to. */
async function toInbox(env: Env, name: string, req: Request, path: string, search: string, prefix = '/'): Promise<Response> {
  const stub = env.INBOX.get(env.INBOX.idFromName(name));
  const res = await stub.fetch(new Request(`https://inbox${path}${search}`, req));
  const set = res.headers.get('set-cookie');
  if (prefix === '/' || !set) return res;
  const scoped = new Response(res.body, res);
  scoped.headers.set('set-cookie', set.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${prefix}`));
  return scoped;
}

/** Hosted inbox addresses are 20 random hex digits and 12 digits of an HMAC over them. */
async function addressTag(secret: string, random: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(random)));
  return [...mac.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function newAddress(secret: string): Promise<string> {
  const random = hex(10);
  return random + (await addressTag(secret, random));
}

export async function validAddress(secret: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(id)) return false;
  const want = await addressTag(secret, id.slice(0, 20));
  let diff = 0;
  for (let i = 0; i < 12; i++) diff |= want.charCodeAt(i) ^ id.charCodeAt(20 + i);
  return diff === 0;
}

/** The owner token this isolate has given its inbox, so single mode sends it once per isolate instead of once per request. */
let adoptedOwner: string | undefined;

/** Serve the built-in page and its files. Assets serve index.html at "/", and answer "/index.html" with a redirect to "/". */
function asset(env: Env, req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  return env.ASSETS.fetch(new Request(new URL(path, url.origin), req));
}

const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Attention</title><style>body{font:16px system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;background:#f6f6f4;color:#1d1d1b}
@media (prefers-color-scheme: dark){body{background:#141413;color:#ececea}}input,button{font:inherit;padding:8px 12px}</style></head>
<body><h1>Your Attention</h1><p>One inbox for the questions your coding agents ask you. Create an inbox with an invite code, then bookmark the address it opens. The address signs you in, so keep it private.</p>
<form id="f"><input id="code" placeholder="Invite code" autocomplete="off" required> <button>Create my inbox</button>
<p><label>PIN <input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" placeholder="4 digits" size="6"></label> <label>Again <input id="pin2" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" placeholder="4 digits" size="6"></label></p>
<p>The inbox page asks for the PIN in each new tab, so someone who gets the address or a sign-in link still cannot answer your agents' cards. Leave it empty to skip, and the page asks again when it opens. <label><input type="checkbox" id="never"> Never ask me for a PIN</label></p>
<p><label><input type="checkbox" id="usage" checked> Send usage counts</label>: once a day, the inbox sends the operator of this service how many cards were posted and answered, pairing requests, page opens, and how many agents, agent processes and tokens connected, with an id made from your invite code. It never sends card text, answers, agent names or addresses. You can change this later on the inbox page.</p></form><p id="out"></p>
<script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const v=(id)=>document.getElementById(id).value,out=document.getElementById('out');
if(v('pin')!==v('pin2')){out.textContent='The two PINs differ.';return}if(v('pin')&&!/^[0-9]{4}$/.test(v('pin'))){out.textContent='A PIN is 4 digits.';return}
const r=await fetch('new',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite:v('code'),usage:document.getElementById('usage').checked,...(v('pin')?{pin:v('pin')}:{neverAsk:document.getElementById('never').checked})})});const d=await r.json();
if(d.unlock){try{sessionStorage.setItem('ya-unlock:'+new URL(d.url).pathname,d.unlock)}catch{}}if(d.login){location.href=d.login}else{out.textContent=d.error}}</script></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (env.MODE !== 'hosted') {
      if (url.pathname.startsWith('/v1/')) {
        if (!(await allowed(env, req, 'main'))) return tooMany();
        if (env.OWNER_TOKEN && adoptedOwner !== env.OWNER_TOKEN) {
          const init = await env.INBOX.get(env.INBOX.idFromName('main')).fetch('https://inbox/_init', { method: 'POST', body: JSON.stringify({ ownerToken: env.OWNER_TOKEN }) });
          if (!init.ok) return json(await init.json().catch(() => ({ error: 'the inbox did not start' })), init.status);
          adoptedOwner = env.OWNER_TOKEN;
        }
        return toInbox(env, 'main', req, url.pathname, url.search);
      }
      return asset(env, req, url.pathname);
    }

    if (url.pathname === '/') return new Response(LANDING, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const secret = env.INBOX_ID_SECRET;
    if (!secret) return json({ error: 'hosted mode needs the INBOX_ID_SECRET secret' }, 500);
    if (url.pathname === '/new' && req.method === 'POST') {
      if (!(await allowed(env, req, ''))) return tooMany();
      if (Number(req.headers.get('content-length') ?? 0) > 1024) return json({ error: 'body too large' }, 413);
      const { invite, usage, pin, neverAsk } = (await req.json().catch(() => ({}))) as { invite?: string; usage?: unknown; pin?: unknown; neverAsk?: unknown };
      if (pin !== undefined && !validPin(pin)) return json({ error: 'A PIN is 4 digits.' }, 400);
      const code = String(invite ?? '').trim().slice(0, 200);
      const redeemed = code.length >= MIN_INVITE_LENGTH ? (await (await env.REGISTRY.get(env.REGISTRY.idFromName('invites')).fetch('https://registry/redeem', { method: 'POST', body: JSON.stringify({ code }) })).json()) as { ok: boolean } : { ok: false };
      if (!redeemed.ok) return json({ error: 'That invite code is not valid.' }, 403);
      const id = await newAddress(secret);
      await env.INVITES.put(`inbox:${id}`, String(Date.now()));
      // A client that sends no `usage` choice never showed the notice, so the inbox page shows it before anything is sent.
      const init = { usage: { invite: await inviteId(code), ...(typeof usage === 'boolean' ? { enabled: usage } : {}) }, pin, neverAsk: neverAsk === true };
      const res = await env.INBOX.get(env.INBOX.idFromName(id)).fetch('https://inbox/_init', { method: 'POST', body: JSON.stringify(init) });
      const { owner, unlock } = (await res.json()) as { owner: string; unlock?: string };
      const base = `${url.origin}/i/${id}/`;
      // The landing page keeps `unlock` in the tab's session storage, so the inbox opens unlocked in that tab only.
      return json({ url: base, login: `${base}#token=${owner}`, ...(unlock ? { unlock } : {}) }, 201);
    }
    const m = /^\/i\/([0-9a-f]{32})(\/.*)?$/.exec(url.pathname);
    if (!m) return json({ error: 'not found' }, 404);
    const id = m[1] ?? '';
    // The page finds the API next to its own address, so the address must end with a slash.
    if (m[2] === undefined) return Response.redirect(`${url.origin}/i/${id}/${url.search}`, 301);
    const rest = m[2];
    // Only the Worker can sign an address, so a guessed one reaches no Durable Object and no KV read.
    if (!(await validAddress(secret, id))) return json({ error: 'no inbox at this address' }, 404);
    if (rest.startsWith('/v1/')) {
      if (!(await allowed(env, req, id))) return tooMany();
      return toInbox(env, id, req, rest, url.search, `/i/${id}/`);
    }
    return asset(env, req, rest);
  },
};

export { InboxObject, RegistryObject };
