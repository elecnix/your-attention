// Seals a secret for one agent: AES-256-GCM for the value, and the AES key
// wrapped with the agent's RSA-OAEP public key. The inbox stores only the
// result, and only the agent that asked holds the private key.
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

export async function seal(publicJwk, text) {
  const pub = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(text));
  const key = await crypto.subtle.wrapKey('raw', aes, pub, { name: 'RSA-OAEP' });
  return { alg: 'RSA-OAEP-256+A256GCM', key: b64(key), iv: b64(iv), data: b64(data) };
}
