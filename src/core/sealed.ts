// Sealed secrets: the agent side, a key pair per card and opening what the page sealed with web/sealed.js, and the
// inbox side, the fields of a card that take only a sealed value. Web Crypto only.
import { InboxError } from './inbox.ts';
import { isOtpApproval, MAX_PURPOSE_CHARS } from './otp.ts';
import type { Candidate } from './secret-sources.ts';
import type { Answer, Card, Sealed } from './types.ts';

export const SEAL_ALG = 'RSA-OAEP-256+A256GCM';
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;
const bytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function newSealKeys(): Promise<{ publicKey: JsonWebKey; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['wrapKey', 'unwrapKey'])) as CryptoKeyPair;
  return { publicKey: (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey, privateKey: pair.privateKey };
}

/** Base64 in chunks, since spreading a large buffer into one call overflows the stack. */
function base64(buf: ArrayBuffer | Uint8Array): string {
  const all = new Uint8Array(buf);
  let text = '';
  for (let i = 0; i < all.length; i += 0x8000) text += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Seal `text` to an agent's public key, as web/sealed.js does in the page. A secret source seals with it, so the value
 * leaves the source only as ciphertext. */
export async function sealValue(publicKey: JsonWebKey, text: string): Promise<Sealed> {
  const pub = await crypto.subtle.importKey('jwk', publicKey, RSA, false, ['wrapKey']);
  const aes = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])) as CryptoKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(text));
  const key = await crypto.subtle.wrapKey('raw', aes, pub, { name: 'RSA-OAEP' });
  return { alg: SEAL_ALG, key: base64(key), iv: base64(iv), data: base64(data) };
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

/** A field the secret_access widget places: the secret's name, the card's public key, and the candidates it offers. */
export interface AccessField {
  name: string;
  publicKey: string;
  candidates: Candidate[];
}

const ACCESS_LITERALS = 'SecretAccess takes three string literals, the field name, the public key and the candidates. Place it with the secret_access widget: db = widget secret_access {"name": "DATABASE_URL", "query": {"name": "DATABASE_URL"}}';

/** Each candidate needs these as text. Other fields, such as a status the lookup gave, stay as the card gave them. */
const CANDIDATE_FIELDS = ['id', 'source', 'instance', 'label'] as const;

function candidatesOf(name: string, text: string): Candidate[] {
  const bad = (): InboxError => new InboxError(400, `secret ${name}: the candidates must be a JSON list of objects with id, source, instance and label as text, as POST /v1/secrets/lookup answers them`);
  let list: unknown;
  try { list = JSON.parse(text); } catch { throw bad(); }
  if (!Array.isArray(list)) throw bad();
  for (const c of list) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || CANDIDATE_FIELDS.some((k) => typeof (c as Record<string, unknown>)[k] !== 'string')) throw bad();
  }
  return list as Candidate[];
}

/** The SecretInput and SecretAccess calls in a body, in order, read with the OpenUI parser's strings, comments and
 * fences. Each call must give its arguments as string literals, so the inbox knows every field that takes only a
 * sealed value, and the candidates each access field offers. */
function secretCalls(body: string): { name: string; publicKey: string; candidates?: Candidate[] }[] {
  const calls: { name: string; publicKey: string; candidates?: Candidate[] }[] = [];
  for (const call of literalCalls(body, { SecretInput: 2, SecretAccess: 3 })) {
    if (!call.args) throw new InboxError(400, call.word === 'SecretInput' ? LITERALS : ACCESS_LITERALS);
    const [name = '', key = '', candidates] = call.args;
    if (!FIELD_NAME.test(name)) throw new InboxError(400, `secret ${JSON.stringify(name)}: the name must be a variable name, such as API_KEY`);
    if (calls.some((c) => c.name === name)) throw new InboxError(400, `the card asks for ${name} twice: give each secret its own name`);
    checkPublicKey(`secret ${name}`, key);
    calls.push(candidates === undefined ? { name, publicKey: key } : { name, publicKey: key, candidates: candidatesOf(name, candidates) });
  }
  return calls;
}

/** Refuse a key that is not an RSA public key as JSON Web Key text, naming the field as `what`. */
function checkPublicKey(what: string, key: string): void {
  if (!key) throw new InboxError(400, `${what} needs the public key that card_post fills in. Post the card with the card_post tool of a Claude Code, pi or opencode session, which keeps the private key`);
  let jwk: Record<string, unknown>;
  try { jwk = JSON.parse(key) as Record<string, unknown>; } catch { throw new InboxError(400, `${what}: the public key must be an RSA key as JSON Web Key text`); }
  if (!jwk || typeof jwk !== 'object' || jwk['kty'] !== 'RSA' || typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') throw new InboxError(400, `${what}: the public key must be an RSA key as JSON Web Key text`);
  if (PRIVATE_MEMBERS.some((k) => Object.hasOwn(jwk, k))) throw new InboxError(400, `${what}: the key is a private key. The private key never leaves the agent's session: place only the public key`);
}

/** The calls of the named components in a body, in order, read with the OpenUI parser's strings, comments and fences.
 * `counts` gives how many string literals each component takes. A call that does not give exactly that many, each a
 * string literal, has `args` undefined, so its reader can say what the component takes. */
function literalCalls(body: string, counts: Record<string, number>): { word: string; args: string[] | undefined }[] {
  const src = withoutComments(fencedCode(body.trim())).trim();
  const out: { word: string; args: string[] | undefined }[] = [];
  const space = (i: number) => { while (/\s/.test(src[i] ?? '')) i++; return i; };
  let i = 0;
  while (i < src.length) {
    const str = stringAt(src, i);
    if (str) { i = str.end; continue; }
    const word = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 64))?.[0];
    if (!word) { i++; continue; }
    i += word.length;
    const count = Object.hasOwn(counts, word) ? counts[word] : undefined;
    if (count === undefined || src[space(i)] !== '(') continue;
    const args: string[] = [];
    let at = space(space(i) + 1);
    for (;;) {
      const arg = stringAt(src, at);
      if (!arg) break;
      args.push(arg.value);
      at = space(arg.end);
      if (args.length === count || src[at] !== ',') break;
      at = space(at + 1);
    }
    const whole = args.length === count && src[at] === ')';
    out.push({ word, args: whole ? args : undefined });
    if (!whole) return out;
    i = at + 1;
  }
  return out;
}

/** A field the privileged_action widget places: the command the card shows, the machine it runs on, and what it changes. */
export interface PrivilegedField {
  name: string;
  command: string;
  machine: string;
  changes: string;
}

const PRIVILEGED_LITERALS = 'PrivilegedAction takes four string literals: the field name, the command, the machine and what it changes. Place it with the privileged_action widget: restart = widget privileged_action {"name": "restart", "command": "systemctl restart nginx", "machine": "office-pc", "changes": "Restarts nginx"}';

/** The PrivilegedAction calls in a body, in order, read with the OpenUI parser's strings, comments and fences, as
 * secretCalls reads its calls. Each call gives its arguments as string literals, so the inbox knows the exact command
 * each field approves. */
export function privilegedActions(body: string): PrivilegedField[] {
  const out: PrivilegedField[] = [];
  for (const call of literalCalls(body, { PrivilegedAction: 4 })) {
    if (!call.args) throw new InboxError(400, PRIVILEGED_LITERALS);
    const [name = '', command = '', machine = '', changes = ''] = call.args;
    if (!FIELD_NAME.test(name)) throw new InboxError(400, `privileged action ${JSON.stringify(name)}: the name must be a field name, such as restart_nginx`);
    if (out.some((c) => c.name === name)) throw new InboxError(400, `the card names the privileged action ${name} twice: give each one its own name`);
    if (!command.trim()) throw new InboxError(400, `privileged action ${name} needs the command it runs`);
    if (!machine.trim()) throw new InboxError(400, `privileged action ${name} needs the machine it runs on`);
    if (!changes.trim()) throw new InboxError(400, `privileged action ${name} needs a sentence that says what it changes`);
    out.push({ name, command, machine, changes });
  }
  return out;
}

/** A field the otp widget places: the variable the code goes in, the enrolled key's label, what the code is for, and
 * the public key of the session that posted the card. */
export interface OtpField {
  name: string;
  key: string;
  purpose: string;
  publicKey: string;
}

const OTP_LITERALS = 'OneTimeCode takes four string literals: the field name, the key\'s label, the purpose and the public key. Place it with the otp widget: npm = widget otp {"name": "npm_config_otp", "key": "npm", "purpose": "npm stage publish your-attention@1.4.0"}';

/** The OneTimeCode calls in a body, in order. Each gives its arguments as string literals, so the inbox knows the key
 * and the purpose the person approves, and the public key it seals the code to. */
export function oneTimeCodes(body: string): OtpField[] {
  const out: OtpField[] = [];
  for (const call of literalCalls(body, { OneTimeCode: 4 })) {
    if (!call.args) throw new InboxError(400, OTP_LITERALS);
    const [name = '', key = '', purpose = '', publicKey = ''] = call.args;
    if (!FIELD_NAME.test(name)) throw new InboxError(400, `one-time code ${JSON.stringify(name)}: the name must be a variable name, such as npm_config_otp, since each command gets the code in it`);
    if (out.some((c) => c.name === name)) throw new InboxError(400, `the card names the one-time code ${name} twice: give each one its own name`);
    if (!key.trim()) throw new InboxError(400, `one-time code ${name} needs the label of an enrolled key, such as npm`);
    if (!purpose.trim()) throw new InboxError(400, `one-time code ${name} needs a purpose: one line that says what the code is for, such as "npm stage publish your-attention@1.4.0", which the person reads before approving`);
    if (purpose.length > MAX_PURPOSE_CHARS) throw new InboxError(400, `one-time code ${name}: the purpose is ${purpose.length} characters, over the limit of ${MAX_PURPOSE_CHARS}`);
    checkPublicKey(`one-time code ${name}`, publicKey);
    out.push({ name, key: key.trim(), purpose: purpose.trim(), publicKey });
  }
  return out;
}

/** The field names of the SecretInput and SecretAccess calls in a body, in order. Each one takes only a sealed value,
 * or for SecretAccess a grant or a decline. */
export function secretInputs(body: string): string[] {
  return secretCalls(body).map((c) => c.name);
}

/** The SecretAccess fields of a body, with the public key and the candidates each one offers. */
export function secretAccesses(body: string): AccessField[] {
  return secretCalls(body).filter((c): c is AccessField => c.candidates !== undefined);
}

/** The answer fields of a card that take only a sealed value. A secret card that an older inbox stored has one, `sealed`. */
export function sealedFields(card: Pick<Card, 'kind' | 'secrets'>): string[] {
  return card.secrets ?? (card.kind === 'secret' ? ['sealed'] : []);
}

/** The answer without its sealed fields, nor those of the answers before it, for every reader except the agent stream:
 * hooks and webhooks hold no key. A one-time code field says that the person approved and until when, without the
 * ticket, which only the posting session redeems. */
export function withoutSealed(card: Pick<Card, 'kind' | 'secrets'>, answer: Answer): Answer {
  const fields = sealedFields(card);
  // An approval is summarized by its shape, not by the card's field list, so a revision that drops the OneTimeCode
  // call after the approval leaves no ticket for a hook to read.
  const strip = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values)
    .filter(([k]) => !fields.includes(k))
    .map(([k, v]) => [k, isOtpApproval(v) ? { approved: true, key: v.key, purpose: v.purpose, expiresAt: v.expiresAt, ...(v.issuedAt === undefined ? {} : { issuedAt: v.issuedAt }) } : v]));
  return { ...answer, values: strip(answer.values), previous: (answer.previous ?? []).map((p) => ({ ...p, values: strip(p.values ?? {}) })) };
}
