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
// The members of an RSA private key in a JWK. A public key has none of them.
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];
const LITERALS = 'SecretInput takes two string literals, the field name and the public key. Place it with the secret widget: key = widget secret {"name": "API_KEY"}';

// The body as the OpenUI parser reads it, after the steps of @openuidev/lang-core 1.0.1 that decide what is code: the
// code of its ``` fences when it has any, then without // and # comments. A string can hide a call only the way the
// parser's own strings do, so a stray quote in prose or in a comment hides nothing.
function skipDoubleQuoted(input: string, start: number): number {
  if (input[start] !== '"') return start;
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === '\\') i += 2;
    else if (input[i] === '"') return i + 1;
    else i++;
  }
  return i;
}
function fencedCode(input: string): string {
  const blocks: string[] = [];
  const fenceAt = (i: number) => input.startsWith('```', i);
  let i = 0;
  while (i < input.length) {
    let start = -1;
    while (i < input.length) {
      const next = skipDoubleQuoted(input, i);
      if (next > i) { i = next; continue; }
      if (fenceAt(i)) { start = i; break; }
      i++;
    }
    if (start === -1) break;
    let j = input.indexOf('\n', start + 3);
    if (j === -1) { blocks.push(input.slice(start + 3).replace(/^[^\n]*\n?/, '')); break; }
    j++;
    let close = -1;
    let k = j;
    while (k < input.length) {
      const next = skipDoubleQuoted(input, k);
      if (next > k) { k = next; continue; }
      if (fenceAt(k)) { close = k; break; }
      k++;
    }
    blocks.push(input.slice(j, close === -1 ? undefined : close));
    i = close === -1 ? input.length : close + 3;
  }
  // A body that starts with a fence always adds a block above, so lang-core's branch for that case never runs here.
  return blocks.length ? blocks.join('\n') : input;
}
function withoutComments(input: string): string {
  let quote: string | false = false;
  return input.split('\n').map((line) => {
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && i + 1 < line.length) { i++; continue; }
        if (c === quote) quote = false;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if ((c === '/' && line[i + 1] === '/') || c === '#') return line.slice(0, i).trimEnd();
    }
    return line;
  }).join('\n');
}

/** Read the string literal at `i`, as the OpenUI lexer decodes it. Undefined when no string starts there. */
function stringAt(src: string, i: number): { value: string; end: number } | undefined {
  if (src[i] === '"') {
    let j = i + 1;
    let closed = false;
    while (j < src.length) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '"') { j++; closed = true; break; } else j++;
    }
    const raw = src.slice(i, j);
    try { return { value: String(JSON.parse(closed ? raw : `${raw}"`)), end: j }; } catch { return { value: raw.replace(/^"|"$/g, ''), end: j }; }
  }
  if (src[i] === "'") {
    let j = i + 1;
    let value = '';
    while (j < src.length) {
      if (src[j] === '\\') {
        const esc = src[j + 1];
        if (esc !== undefined) value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
        j += 2;
      } else if (src[j] === "'") { j++; break; } else value += src[j++];
    }
    return { value, end: j };
  }
  return undefined;
}

/** The field names of the SecretInput calls in a body, in order, read with the OpenUI parser's strings, comments and
 * fences. Each call must give its field name and an RSA public key as string literals, so the inbox knows every field
 * that takes only a sealed value. */
export function secretInputs(body: string): string[] {
  const src = withoutComments(fencedCode(body.trim())).trim();
  const names: string[] = [];
  const space = (i: number) => { while (/\s/.test(src[i] ?? '')) i++; return i; };
  let i = 0;
  while (i < src.length) {
    const str = stringAt(src, i);
    if (str) { i = str.end; continue; }
    const word = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 64))?.[0];
    if (!word) { i++; continue; }
    i += word.length;
    if (word !== 'SecretInput' || src[space(i)] !== '(') continue;
    const first = stringAt(src, space(space(i) + 1));
    const comma = first ? space(first.end) : -1;
    const second = first && src[comma] === ',' ? stringAt(src, space(comma + 1)) : undefined;
    if (!first || !second || src[space(second.end)] !== ')') throw new InboxError(400, LITERALS);
    i = space(second.end) + 1;
    const name = first.value;
    const key = second.value;
    if (!FIELD_NAME.test(name)) throw new InboxError(400, `secret ${JSON.stringify(name)}: the name must be a variable name, such as API_KEY`);
    if (names.includes(name)) throw new InboxError(400, `the card asks for ${name} twice: give each secret its own name`);
    if (!key) throw new InboxError(400, `secret ${name} needs the public key that card_post fills in. Post the card with the card_post tool of a Claude Code, pi or opencode session, which keeps the private key`);
    let jwk: Record<string, unknown>;
    try { jwk = JSON.parse(key) as Record<string, unknown>; } catch { throw new InboxError(400, `secret ${name}: the public key must be an RSA key as JSON Web Key text`); }
    if (!jwk || typeof jwk !== 'object' || jwk['kty'] !== 'RSA' || typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') throw new InboxError(400, `secret ${name}: the public key must be an RSA key as JSON Web Key text`);
    if (PRIVATE_MEMBERS.some((k) => Object.hasOwn(jwk, k))) throw new InboxError(400, `secret ${name}: the key is a private key. The private key never leaves the agent's session: place only the public key`);
    names.push(name);
  }
  return names;
}

/** The answer fields of a card that take only a sealed value. A secret card that an older inbox stored has one, `sealed`. */
export function sealedFields(card: Pick<Card, 'kind' | 'secrets'>): string[] {
  return card.secrets ?? (card.kind === 'secret' ? ['sealed'] : []);
}

/** The answer without its sealed fields, nor those of the answers before it, for every reader except the agent stream:
 * hooks and webhooks hold no key. */
export function withoutSealed(card: Pick<Card, 'kind' | 'secrets'>, answer: Answer): Answer {
  const fields = sealedFields(card);
  if (!fields.length) return answer;
  const strip = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([k]) => !fields.includes(k)));
  return { ...answer, values: strip(answer.values), previous: (answer.previous ?? []).map((p) => ({ ...p, values: strip(p.values ?? {}) })) };
}
