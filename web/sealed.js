// Seals a secret for one agent: AES-256-GCM for the value, and the AES key
// wrapped with the agent's RSA-OAEP public key. The inbox stores only the
// result, and only the agent that asked holds the private key.
// Base64 in chunks, since spreading a large buffer into one call overflows the stack.
function b64(buf) {
  const all = new Uint8Array(buf);
  let text = '';
  for (let i = 0; i < all.length; i += 0x8000) text += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(text);
}

export async function seal(publicJwk, text) {
  const pub = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(text));
  const key = await crypto.subtle.wrapKey('raw', aes, pub, { name: 'RSA-OAEP' });
  return { alg: 'RSA-OAEP-256+A256GCM', key: b64(key), iv: b64(iv), data: b64(data) };
}
