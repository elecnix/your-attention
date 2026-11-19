// Web Push with Web Crypto only, so the same code runs on Node 22 and in Workers.
// RFC 8291 encrypts the message to the subscriber (aes128gcm, RFC 8188), and RFC 8292 signs
// each request with the inbox's own key (VAPID, ES256). No library: the two RFCs are about
// 150 lines, and `web-push` needs node:crypto, which a Worker does not have.

const encoder = new TextEncoder();
/** UTF-8 bytes in a plain `ArrayBuffer`, the form Web Crypto's types ask for on every platform. */
const enc = { encode: (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text)) };

// The Workers type definitions differ from the DOM ones in three places, so each gets a cast here: key pair generation, JWK export, and the ECDH `public` member.
const generatePair = async (name: 'ECDH' | 'ECDSA', extractable: boolean, usages: ('deriveBits' | 'sign')[]): Promise<CryptoKeyPair> => (await crypto.subtle.generateKey({ name, namedCurve: 'P-256' }, extractable, usages)) as CryptoKeyPair;
const exportRaw = async (key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
const exportJwk = async (key: CryptoKey): Promise<JsonWebKey> => (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
const ecdh = (key: CryptoKey): Parameters<typeof crypto.subtle.deriveBits>[0] => ({ name: 'ECDH', public: key }) as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** A record holds this many bytes, header and padding included. One record holds every message this inbox sends. */
const RECORD_SIZE = 4096;
const HEADER_LENGTH = 16 + 4 + 1 + 65;
/** The most plaintext a single record carries: the record, less the header, the delimiter byte and the 16-byte tag. */
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_LENGTH - 1 - 16;

export interface Subscriber {
  /** The subscriber's public key, 65 bytes, base64url. */
  p256dh: string;
  /** The subscriber's 16-byte authentication secret, base64url. */
  auth: string;
}

/** Import a P-256 key pair from its raw public point and its private scalar, both base64url. */
async function pairFrom(publicKey: string, privateKey: string, usage: 'deriveBits' | 'sign'): Promise<{ priv: CryptoKey; pub: Uint8Array<ArrayBuffer> }> {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('not an uncompressed P-256 point');
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)), d: privateKey, ext: true };
  const algorithm = usage === 'sign' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'ECDH', namedCurve: 'P-256' };
  return { priv: await crypto.subtle.importKey('jwk', jwk, algorithm, false, [usage]), pub };
}

async function hkdf(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** The content key and nonce both sides derive from the shared secret (RFC 8291, section 3.4). */
async function contentKeys(shared: Uint8Array<ArrayBuffer>, auth: Uint8Array<ArrayBuffer>, uaPublic: Uint8Array<ArrayBuffer>, asPublic: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<{ cek: CryptoKey; nonce: Uint8Array<ArrayBuffer> }> {
  const ikm = await hkdf(shared, auth, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  return { cek: await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt', 'decrypt']), nonce };
}

/** Encrypt one message for one subscriber. `test` fixes the salt and the one-time key, for the RFC's test vector. */
export async function encryptPayload(plaintext: Uint8Array, to: Subscriber, test: { salt?: Uint8Array<ArrayBuffer>; ephemeral?: { publicKey: string; privateKey: string } } = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`payload too large: ${plaintext.length} bytes, at most ${MAX_PLAINTEXT}`);
  const auth = b64urlDecode(to.auth);
  if (auth.length !== 16) throw new Error('auth secret must be 16 bytes');
  const uaPublic = b64urlDecode(to.p256dh);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh is not an uncompressed P-256 point');
  const subscriberKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  let priv: CryptoKey;
  let asPublic: Uint8Array<ArrayBuffer>;
  if (test.ephemeral) {
    ({ priv, pub: asPublic } = await pairFrom(test.ephemeral.publicKey, test.ephemeral.privateKey, 'deriveBits'));
  } else {
    const pair = await generatePair('ECDH', false, ['deriveBits']);
    priv = pair.privateKey;
    asPublic = await exportRaw(pair.publicKey);
  }
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(subscriberKey), priv, 256));
  const salt = test.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await contentKeys(shared, auth, uaPublic, asPublic, salt);
  // The 0x02 byte marks the last record, which is the only one.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, concat(plaintext, Uint8Array.of(2))));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, header, Uint8Array.of(asPublic.length), asPublic, sealed);
}

/** Read one message as the subscriber's browser does. The inbox never calls this: tests and the stub push service do. */
export async function decryptPayload(body: Uint8Array<ArrayBuffer>, me: { publicKey: string; privateKey: string; auth: string }): Promise<Uint8Array<ArrayBuffer>> {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idLength);
  const sealed = body.slice(21 + idLength);
  const { priv, pub } = await pairFrom(me.publicKey, me.privateKey, 'deriveBits');
  const senderKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(senderKey), priv, 256));
  const { cek, nonce } = await contentKeys(shared, b64urlDecode(me.auth), pub, asPublic, salt);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cek, sealed));
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (padded[end - 1] !== 2) throw new Error('not the last record');
  return padded.slice(0, end - 1);
}

/** The inbox's own identity to push services: a P-256 key pair, made once and kept with the inbox. */
export interface Vapid {
  /** The public point, 65 bytes, base64url. Browsers pass it as `applicationServerKey`. */
  publicKey: string;
  /** The private key as a JWK. It never leaves the inbox's storage, and nothing logs it. */
  privateKey: { d: string };
}

export async function generateVapid(): Promise<Vapid> {
  const pair = await generatePair('ECDSA', true, ['sign']);
  const jwk = await exportJwk(pair.privateKey);
  return { publicKey: b64urlEncode(await exportRaw(pair.publicKey)), privateKey: { d: String(jwk.d) } };
}

/** The `Authorization` header of a push request: an ES256 token for the push service's origin, valid 12 hours. */
export async function vapidAuthorization(vapid: Vapid, endpoint: string, subject: string, now = Date.now()): Promise<string> {
  const part = (v: unknown): string => b64urlEncode(enc.encode(JSON.stringify(v)));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
  const { priv } = await pairFrom(vapid.publicKey, vapid.privateKey.d, 'sign');
  // Web Crypto's ECDSA signature is r and s, 64 bytes, which is the form JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export interface PushTarget extends Subscriber {
  endpoint: string;
}

export interface PushResult {
  ok: boolean;
  /** The push service no longer knows this subscription (404 or 410), so the inbox forgets it. */
  gone?: true;
  /** The last status the push service sent, or 0 when none answered. */
  status: number;
  attempts: number;
}

/** Tries per push: the first and two retries. A push is a nudge, and a slow push service must not hold anything up. */
const ATTEMPTS = 3;
const RETRY_MS = [500, 1500];
const REQUEST_TIMEOUT_MS = 8000;
/** A message a phone cannot take for a day is no longer news. */
const TTL_SECONDS = 24 * 3600;

const retryable = (status: number): boolean => status === 429 || status >= 500;

/** Send one encrypted message. 404 and 410 say the subscription is gone. A 429, a 5xx or a network error is tried again,
 * twice at most. Every other refusal ends the try. It never throws. */
export async function sendPush(
  fetcher: typeof fetch,
  vapid: Vapid,
  to: PushTarget,
  payload: Uint8Array,
  opts: { subject?: string; wait?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<PushResult> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let status = 0;
  let attempts = 0;
  try {
    const body = await encryptPayload(payload, to);
    while (attempts < ATTEMPTS) {
      if (attempts > 0) await wait(RETRY_MS[attempts - 1] ?? 1500);
      attempts++;
      try {
        const res = await fetcher(to.endpoint, {
          method: 'POST',
          headers: {
            authorization: await vapidAuthorization(vapid, to.endpoint, opts.subject ?? 'https://github.com/elecnix/your-attention', opts.now?.()),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(TTL_SECONDS),
            urgency: 'high',
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = res.status;
        // The body of a refusal is the push service's, and nothing here reads it.
        await res.body?.cancel().catch(() => {});
      } catch {
        status = 0;
        continue;
      }
      if (status >= 200 && status < 300) return { ok: true, status, attempts };
      if (status === 404 || status === 410) return { ok: false, gone: true, status, attempts };
      if (!retryable(status)) break;
    }
  } catch {
    // A subscription whose keys do not encrypt gets no push.
  }
  return { ok: false, status, attempts };
}
