// The usage collector: a small Worker apart from the inbox Worker. A laptop inbox posts one
// report a day here, and the collector writes it to the Analytics Engine dataset that hosted
// inboxes write directly. It checks each report against the fixed fields, and keeps no address.
import { dataPoint, parseReport } from '../core/telemetry.ts';

export interface CollectorEnv {
  USAGE: AnalyticsEngineDataset;
  /** Counts reports per sender address. The address is the limiter's key only, never stored. */
  LIMITER?: RateLimit;
}

/** A report is about 300 bytes. */
const MAX_BODY = 2048;

const json = (data: unknown, status: number): Response => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

/** Read at most MAX_BODY bytes, counting what arrives, so a wrong Content-Length cannot make the Worker read more. */
async function readBody(req: Request): Promise<string | undefined> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

export default {
  async fetch(req: Request, env: CollectorEnv): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/v1/health') return json({ ok: true }, 200);
    if (req.method !== 'POST' || url.pathname !== '/v1/report') return json({ error: 'not found' }, 404);
    if (env.LIMITER && !(await env.LIMITER.limit({ key: req.headers.get('cf-connecting-ip') ?? 'unknown' })).success) return json({ error: 'too many reports, try again tomorrow' }, 429);
    const text = await readBody(req);
    if (text === undefined) return json({ error: `the body is over ${MAX_BODY} bytes` }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json({ error: 'the body is not JSON' }, 400); }
    const report = parseReport(body, Date.now());
    if (typeof report === 'string') return json({ error: report }, 400);
    // Hosted inboxes write their own data points. A report here that claims an invite is not from a laptop.
    if (report.source !== 'laptop' || report.invite !== '') return json({ error: 'only laptop reports come here' }, 400);
    env.USAGE.writeDataPoint(dataPoint(report));
    return new Response(null, { status: 204 });
  },
};
