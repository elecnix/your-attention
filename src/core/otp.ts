// One-time codes: the inbox keeps a TOTP key, such as the authenticator key of an npm account, and computes a code
// when an agent redeems the ticket that the person's approval of an `otp` card minted. The digits go to the agent's
// session sealed to the card's public key, and nothing else ever holds them: not the answer, not a log, not a hook.
// SPEC.md#one-time-codes holds the contract. Web Crypto only, so your own inbox and the hosted one share it.
import { InboxError } from './inbox.ts';

/** RFC 6238 with the parameters every authenticator app and npm use: HMAC-SHA-1, six digits, 30-second steps. */
export const STEP_MS = 30_000;
export const DIGITS = 6;
/** The steps the verifier accepts on each side of the current one, to absorb clock skew. */
export const WINDOW = 1;
/** How long a ticket stays redeemable after the person approves. An agent with an open stream redeems in seconds; the
 * rest covers an agent busy with a command, or one whose stream reconnects. Past it the approval no longer stands for
 * the moment the person gave it, and the agent asks again. */
export const TICKET_MS = 10 * 60_000;
/** The shortest key the inbox takes, 80 bits, which is what older authenticator services issue. */
export const MIN_KEY_BYTES = 10;
export const MAX_PURPOSE_CHARS = 300;
/** A key's label, as a card names it: `npm`, `npm-elecnix`. */
export const KEY_LABEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** An agent id, as a session reports it on its stream. */
export const AGENT_ID = /^\S{1,80}$/;

/** Where an inbox keeps its keys. Your own inbox writes a file of mode 0600 in its home folder; the hosted inbox
 * encrypts each key under a Worker secret. The inbox reads a key only inside a redemption, to compute one code. */
export interface OtpKeyStore {
  /** Which inbox holds the keys, and how, in a phrase the card shows: "your own inbox on mbp, in a file only its
   * user reads". */
  readonly holder: string;
  save(label: string, key: Uint8Array): Promise<void>;
  /** The key, or undefined when none has that label. It throws when the stored key no longer decrypts. */
  load(label: string): Promise<Uint8Array | undefined>;
  remove(label: string): Promise<void>;
}

/** What the inbox keeps about an enrolled key in its own storage. The key itself stays in the key store. */
export interface OtpKeyRecord {
  label: string;
  /** The agent ids that may post a card for this key. */
  allow: string[];
  /** SHA-256 of the key's bytes, hex, taken at enrollment, so a key that changed in storage is refused. */
  checksum: string;
  enrolledAt: number;
  /** When the inbox last issued a code from this key. Never which code. */
  lastIssuedAt?: number;
}

/** What `GET /v1/otp/keys` answers for each key: no key bytes and no checksum. */
export interface OtpKeyInfo {
  label: string;
  allow: string[];
  enrolledAt: number;
  lastIssuedAt?: number;
}

/** A ticket the person's approval minted, in the inbox's storage. */
export interface OtpTicket {
  id: string;
  card: string;
  field: string;
  agent: string;
  /** The id of the token that posted the card. Only that token redeems the ticket. */
  token: string;
  key: string;
  purpose: string;
  /** The card's public key, as JWK text, which the code is sealed to. */
  publicKey: string;
  approvedAt: number;
  expiresAt: number;
  issuedAt?: number;
}

/** An otp field's value in the answer once the person approved: the ticket, never a code. */
export interface OtpApproval {
  ticket: string;
  key: string;
  purpose: string;
  approvedAt: number;
  /** When the ticket stops being redeemable. */
  expiresAt: number;
  /** When the inbox issued the code, once the agent redeemed the ticket. */
  issuedAt?: number;
}

export function isOtpApproval(v: unknown): v is OtpApproval {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return typeof a['ticket'] === 'string' && typeof a['key'] === 'string' && typeof a['expiresAt'] === 'number';
}

export const isOtpDecline = (v: unknown): boolean => Boolean(v && typeof v === 'object' && (v as { decline?: unknown }).decline === true);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, as authenticator setups show it: any case, with spaces and padding ignored. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new InboxError(400, `the key is not base32: it holds ${JSON.stringify(c)}, and base32 has only the letters A to Z and the digits 2 to 7`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The key the person gives at enrollment: the base32 text an authenticator setup shows, or its whole `otpauth://`
 * address. An address must ask for the parameters this inbox computes, since a code from any other would fail. */
export function readKey(input: string): Uint8Array {
  const text = String(input ?? '').trim();
  if (!text) throw new InboxError(400, 'give the key: the base32 text the service shows when you set up an authenticator, or its otpauth:// address');
  let secret = text;
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { throw new InboxError(400, 'the otpauth:// address does not parse'); }
    if (url.host.toLowerCase() !== 'totp') throw new InboxError(400, `the address is for ${url.host || 'no type'} codes, and this inbox computes only time-based (totp) codes`);
    const p = url.searchParams;
    const algorithm = (p.get('algorithm') ?? 'SHA1').toUpperCase();
    if (algorithm !== 'SHA1') throw new InboxError(400, `the address asks for ${algorithm}, and this inbox computes SHA1 codes only`);
    if ((p.get('digits') ?? '6') !== String(DIGITS)) throw new InboxError(400, `the address asks for ${p.get('digits')} digits, and this inbox computes ${DIGITS}`);
    if ((p.get('period') ?? '30') !== String(STEP_MS / 1000)) throw new InboxError(400, `the address asks for steps of ${p.get('period')} seconds, and this inbox computes steps of ${STEP_MS / 1000}`);
    secret = p.get('secret') ?? '';
    if (!secret) throw new InboxError(400, 'the otpauth:// address has no secret');
  }
  const key = base32Decode(secret);
  if (key.length < MIN_KEY_BYTES) throw new InboxError(400, `the key is ${key.length} bytes, and a TOTP key has at least ${MIN_KEY_BYTES}: check that you copied all of it`);
  return key;
}

/** The time step that contains `at`, in epoch milliseconds. */
export const stepOf = (at: number): number => Math.floor(at / STEP_MS);

/** The code of one step, per RFC 4226 section 5.3 with the step as its counter. */
async function codeAt(key: Uint8Array, step: number): Promise<string> {
  const hmacKey = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, counter));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for the step that contains `at`. */
export function totp(key: Uint8Array, at: number): Promise<string> {
  return codeAt(key, stepOf(at));
}

/** Whether `code` is the code of the step that contains `at`, or of a step at most WINDOW away from it. */
export async function verifyTotp(key: Uint8Array, code: string, at: number): Promise<boolean> {
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(String(code))) return false;
  const now = stepOf(at);
  let match = false;
  // Every step in the window is computed, so the time taken does not say which step matched.
  for (let s = now - WINDOW; s <= now + WINDOW; s++) if (await codeAt(key, s) === code) match = true;
  return match;
}

export async function keyChecksum(key: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The code to send for `at`, and when its step ends. It refuses rather than send a code that would fail: a key whose
 * bytes differ from the ones enrolled, or a code the verifier does not accept. `compute` is the generator, which a test
 * replaces to prove the verifier stops a wrong code. */
export async function issueCode(label: string, key: Uint8Array, checksum: string, at: number, compute: (key: Uint8Array, at: number) => Promise<string> = totp): Promise<{ code: string; expiresAt: number }> {
  if (await keyChecksum(key) !== checksum) {
    throw new InboxError(500, `the key ${label} is damaged: its bytes no longer match the ones enrolled, so the inbox sent no code. Enroll it again with \`your-attention otp enroll ${label}\``);
  }
  const code = await compute(key, at);
  if (!(await verifyTotp(key, code, at))) {
    throw new InboxError(500, `the code computed from the key ${label} failed the inbox's own check, so the inbox sent no code. Enroll the key again with \`your-attention otp enroll ${label}\``);
  }
  return { code, expiresAt: (stepOf(at) + 1) * STEP_MS };
}

/** A UTC clock time for messages, such as 14:03:12 UTC. */
export const utc = (at: number): string => `${new Date(at).toISOString().slice(11, 19)} UTC`;
