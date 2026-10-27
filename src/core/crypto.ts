// Ids, secrets and hashes, with Web Crypto only.

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomId(bytes = 8): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A six-digit code the person compares on both screens when pairing. */
export function pairingCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(n % 1_000_000).padStart(6, '0');
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/** A token secret: the token id, a dot, and 32 random bytes. */
export function newSecret(id: string): string {
  return `${id}.${randomId(32)}`;
}
