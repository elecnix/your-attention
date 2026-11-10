// Sealed secrets: the agent side, a key pair per card and opening what the page sealed with web/sealed.js, and the
// inbox side, the fields of a card that take only a sealed value. Web Crypto only.
import { InboxError } from './inbox.ts';
import type { Answer, Card, Sealed } from './types.ts';

export const SEAL_ALG = 'RSA-OAEP-256+A256GCM';
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;
const bytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function newSealKeys(): Promise<{ publicKey: JsonWebKey; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['wrapKey', 'unwrapKey'])) as CryptoKeyPair;
  return { publicKey: (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey, privateKey: pair.privateKey };
}

export async function openSealed(privateKey: CryptoKey, sealed: Sealed): Promise<string> {
  if (sealed.alg !== SEAL_ALG) throw new Error(`unknown sealing ${sealed.alg}`);
  const aes = await crypto.subtle.unwrapKey('raw', bytes(sealed.key), privateKey, { name: 'RSA-OAEP' }, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv) }, aes, bytes(sealed.data));
  return new TextDecoder().decode(plain);
}

/** Whether a value has the fields of a sealed secret. */
export function isSealed(v: unknown): v is Sealed {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return s['alg'] === SEAL_ALG && ['key', 'iv', 'data'].every((k) => typeof s[k] === 'string');
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// A string literal, or the start of a SecretInput call outside one.
const SCAN = /"(?:[^"\\]|\\.)*"|\bSecretInput\s*\(/g;
const ARGS = /SecretInput\s*\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/y;
// The members of an RSA private key in a JWK. A public key has none of them.
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

/** The field names of the SecretInput calls in a body, in order. Each must name its field and give an RSA public key,
 * both as string literals, so the inbox knows every field that takes only a sealed value. */
export function secretInputs(body: string): string[] {
  const names: string[] = [];
  for (const m of body.matchAll(SCAN)) {
    if (m[0].startsWith('"')) continue;
    ARGS.lastIndex = m.index;
    const args = ARGS.exec(body);
    if (!args) throw new InboxError(400, 'SecretInput takes two string literals, the field name and the public key. Place it with the secret widget: key = widget secret {"name": "API_KEY"}');
    const name = JSON.parse(args[1]!) as string;
    const key = JSON.parse(args[2]!) as string;
    if (!FIELD_NAME.test(name)) throw new InboxError(400, `secret ${JSON.stringify(name)}: the name must be a variable name, such as API_KEY`);
    if (names.includes(name)) throw new InboxError(400, `the card asks for ${name} twice: give each secret its own name`);
    if (!key) throw new InboxError(400, `secret ${name} needs the public key that card_post fills in. Post the card with the card_post tool of a Claude Code, pi or opencode session, which keeps the private key`);
    let jwk: Record<string, unknown>;
    try { jwk = JSON.parse(key) as Record<string, unknown>; } catch { throw new InboxError(400, `secret ${name}: the public key must be an RSA key as JSON Web Key text`); }
    if (!jwk || typeof jwk !== 'object' || jwk['kty'] !== 'RSA' || typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') throw new InboxError(400, `secret ${name}: the public key must be an RSA key as JSON Web Key text`);
    if (PRIVATE_MEMBERS.some((k) => k in jwk)) throw new InboxError(400, `secret ${name}: the key is a private key. The private key never leaves the agent's session: place only the public key`);
    names.push(name);
  }
  return names;
}

/** The answer fields of a card that take only a sealed value. A secret card that an older inbox stored has one, `sealed`. */
export function sealedFields(card: Pick<Card, 'kind' | 'secrets'>): string[] {
  return card.secrets ?? (card.kind === 'secret' ? ['sealed'] : []);
}

/** The answer without its sealed fields, for every reader except the agent stream: hooks and webhooks hold no key. */
export function withoutSealed(card: Pick<Card, 'kind' | 'secrets'>, answer: Answer): Answer {
  const fields = sealedFields(card);
  if (!fields.some((f) => f in answer.values)) return answer;
  return { ...answer, values: Object.fromEntries(Object.entries(answer.values).filter(([k]) => !fields.includes(k))) };
}
