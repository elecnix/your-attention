// The hosted inbox's one-time code keys. Each key is encrypted with AES-GCM before it reaches the Durable Object's
// storage, under a key that HKDF derives from the Worker secret OTP_KEY_SECRET and the inbox's id, so one inbox's
// ciphertext opens with no other inbox's key. The plaintext key exists only in the Worker's memory while it computes a
// code. A deployment without the secret keeps no keys, and the inbox says so. Web Crypto only.
import type { OtpKeyStore } from '../core/otp.ts';
import type { Storage } from '../core/storage.ts';

interface SealedKey { iv: string; data: string }

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function wrappingKey(secret: string, inbox: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(inbox), info: new TextEncoder().encode('your-attention one-time code keys v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export function sealedOtpKeys(secret: string, inbox: string, store: Storage): OtpKeyStore {
  const key = wrappingKey(secret, inbox);
  // The label is the additional data, so a ciphertext copied under another label does not open.
  const aad = (label: string) => new TextEncoder().encode(`otp key ${label}`);
  return {
    holder: 'the hosted inbox, encrypted under its Worker\'s secret, and decrypted in the Worker\'s memory for each code',
    save: async (label, bytes) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(label) }, await key, new Uint8Array(bytes)));
      store.put<SealedKey>('otpsealed', label, { iv: b64(iv), data: b64(data) });
    },
    load: async (label) => {
      const sealed = store.get<SealedKey>('otpsealed', label);
      if (!sealed) return undefined;
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: aad(label) }, await key, unb64(sealed.data)));
      } catch {
        throw new Error('its ciphertext does not decrypt with this Worker\'s OTP_KEY_SECRET');
      }
    },
    remove: async (label) => { store.delete('otpsealed', label); },
  };
}
