// Hosted inbox addresses: 20 random hex digits and 12 digits of an HMAC over them, signed with the INBOX_ID_SECRET the
// Worker holds. The Worker signs an address and checks it, and the deploy's smoke check mints one to prove the page
// answers, so both read this file and neither keeps a copy of the rule.

/** Hex digits for `bytes` random bytes. */
export function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The 12 hex digits that sign `random`, the first 20 digits of an address. */
export async function addressTag(secret: string, random: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(random)));
  return [...mac.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh address: 20 hex digits of random, and the 12 digits that sign them. */
export async function newAddress(secret: string): Promise<string> {
  const random = hex(10);
  return random + (await addressTag(secret, random));
}

/** Whether `id` carries the signature this secret gives it. */
export async function validAddress(secret: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(id)) return false;
  const want = await addressTag(secret, id.slice(0, 20));
  let diff = 0;
  for (let i = 0; i < 12; i++) diff |= want.charCodeAt(i) ^ id.charCodeAt(20 + i);
  return diff === 0;
}
