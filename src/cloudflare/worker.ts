// The Cloudflare build. MODE "single" serves one inbox, for a person who
// deploys their own. MODE "hosted" serves many: each inbox is created with an
// invite code, lives at an unguessable /i/<id>/ address, and is one Durable
// Object that hibernates when nobody uses it.
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
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Send a request to the inbox object, with the path the inbox expects. */
function toInbox(env: Env, name: string, req: Request, path: string, search: string): Promise<Response> {
  const stub = env.INBOX.get(env.INBOX.idFromName(name));
  return stub.fetch(new Request(`https://inbox${path}${search}`, req));
}

/** Serve the built-in page and its files. */
function asset(env: Env, req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  return env.ASSETS.fetch(new Request(new URL(path === '/' ? '/index.html' : path, url.origin), req));
}

const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Attention</title><style>body{font:16px system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;background:#f6f6f4;color:#1d1d1b}
@media (prefers-color-scheme: dark){body{background:#141413;color:#ececea}}input,button{font:inherit;padding:8px 12px}</style></head>
<body><h1>Your Attention</h1><p>One inbox for the questions your coding agents ask you. Create an inbox with an invite code, then bookmark the address it opens: the address is the key.</p>
<form id="f"><input id="code" placeholder="Invite code" autocomplete="off" required> <button>Create my inbox</button></form><p id="out"></p>
<script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('new',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite:document.getElementById('code').value})});const d=await r.json();if(d.login){location.href=d.login}else{document.getElementById('out').textContent=d.error}}</script></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (env.MODE !== 'hosted') {
      if (url.pathname.startsWith('/v1/')) {
        if (env.OWNER_TOKEN) await env.INBOX.get(env.INBOX.idFromName('main')).fetch('https://inbox/_init', { method: 'POST', body: JSON.stringify({ ownerToken: env.OWNER_TOKEN }) });
        return toInbox(env, 'main', req, url.pathname, url.search);
      }
      return asset(env, req, url.pathname);
    }

    if (url.pathname === '/') return new Response(LANDING, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/new' && req.method === 'POST') {
      const { invite } = (await req.json().catch(() => ({}))) as { invite?: string };
      const code = String(invite ?? '').trim();
      const redeemed = code ? (await (await env.REGISTRY.get(env.REGISTRY.idFromName('invites')).fetch('https://registry/redeem', { method: 'POST', body: JSON.stringify({ code }) })).json()) as { ok: boolean } : { ok: false };
      if (!redeemed.ok) return json({ error: 'That invite code is not valid.' }, 403);
      const id = hex(16);
      await env.INVITES.put(`inbox:${id}`, String(Date.now()));
      const res = await env.INBOX.get(env.INBOX.idFromName(id)).fetch('https://inbox/_init', { method: 'POST', body: '{}' });
      const { owner } = (await res.json()) as { owner: string };
      const base = `${url.origin}/i/${id}/`;
      return json({ url: base, login: `${base}#token=${owner}` }, 201);
    }
    const m = /^\/i\/([0-9a-f]{32})(\/.*)?$/.exec(url.pathname);
    if (!m) return json({ error: 'not found' }, 404);
    const id = m[1] ?? '';
    // The page finds the API next to its own address, so the address must end with a slash.
    if (m[2] === undefined) return Response.redirect(`${url.origin}/i/${id}/${url.search}`, 301);
    const rest = m[2];
    // An address nobody created reaches no Durable Object, so guessing costs nothing to run.
    if (!(await env.INVITES.get(`inbox:${id}`))) return json({ error: 'no inbox at this address' }, 404);
    if (rest.startsWith('/v1/')) return toInbox(env, id, req, rest, url.search);
    return asset(env, req, rest);
  },
};

export { InboxObject, RegistryObject };
