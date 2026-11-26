// The deploy's last check: mint a valid inbox address with the same secret the Worker checks, then ask the site it just
// deployed for that inbox's page and for its `/v1/info`. A deploy that broke the page or the Durable Object turns red
// here, in seconds, instead of being found by the first person who opens their inbox.
//
// Usage: node scripts/deploy-smoke.ts https://app.example.workers.dev
import { newAddress } from '../src/cloudflare/address.ts';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
const secret = process.env.INBOX_ID_SECRET ?? '';

/** A request the Worker will not refuse for looking like a bot: Cloudflare answers a bare curl with error code 1010. */
const UA = 'your-attention-deploy-smoke/1.0';

function stop(why: string): never {
  console.error(`::error::${why}`);
  process.exit(1);
}

if (!base) stop('the smoke check needs the address of the deployment, such as https://app.example.workers.dev');
if (!/^https?:\/\//.test(base)) stop(`the smoke check needs an http address, not ${base}`);
if (!secret) stop('the smoke check needs INBOX_ID_SECRET, the key that signs an inbox address');

const id = await newAddress(secret);
const page = await fetch(`${base}/i/${id}/`, { headers: { 'user-agent': UA }, redirect: 'manual' }).catch((e: Error) => stop(`the page request failed: ${e.message}`));

if (page.status !== 200) stop(`the page answered ${page.status} for a signed address, so the deployment serves no inbox page`);
const html = await page.text();
if (!/<title>[^<]*your attention/i.test(html)) stop(`the page answered 200 without its title, so the deployment serves something else: ${html.slice(0, 200)}`);
console.log(`page: 200, ${html.length} bytes, with its title`);

const info = await fetch(`${base}/i/${id}/v1/info`, { headers: { 'user-agent': UA } }).catch((e: Error) => stop(`the /v1/info request failed: ${e.message}`));
if (info.status !== 200) stop(`/v1/info answered ${info.status}, so the inbox object does not answer`);
const body = (await info.json().catch(() => undefined)) as { version?: string } | undefined;
if (!body || typeof body.version !== 'string') stop(`/v1/info answered 200 without a version: ${JSON.stringify(body).slice(0, 200)}`);
console.log(`/v1/info: 200, version ${body.version}`);
