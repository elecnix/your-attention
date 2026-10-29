// The PIN never leaves the device. The page derives a key from it with PBKDF2-SHA256, using the salt and
// iterations the inbox hands out at GET /v1/pin, and sends the key. src/core/pin.ts derives the same key.
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((b) => parseInt(b, 16)));

export async function pinKey(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations }, key, 256));
}

/** A new PIN's key, with a fresh random 16-byte salt. */
export async function newPinKey(pin, iterations) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { key: await pinKey(pin, salt, iterations), salt, iterations };
}
