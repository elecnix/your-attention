// The agent side of a sealed secret: a key pair per request, and opening
// what the page sealed with web/sealed.js. Web Crypto only.
import type { Sealed } from './types.ts';

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
