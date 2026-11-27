// The laptop inbox's one-time code keys: one file, otp-keys.json, in the inbox's home folder beside owner-token, of mode
// 0600 in a folder of mode 0700. A TOTP key can't be stored as a hash, since the inbox computes each code with the key
// itself, so the file's mode is what protects it: only the user that runs the inbox reads it. The inbox reads a key only
// inside a redemption. SPEC.md#where-the-keys-live says why this is the exception to the rule that tokens are hashed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { base32Decode, base32Encode, type OtpKeyStore } from '../core/otp.ts';
import { writePrivate } from './home.ts';

export const OTP_KEYS_FILE = 'otp-keys.json';

export function fileOtpKeys(home: string, machine: string): OtpKeyStore {
  const file = path.join(home, OTP_KEYS_FILE);
  const shown = home === path.join(os.homedir(), '.your-attention') ? `~/.your-attention/${OTP_KEYS_FILE}` : file;
  const read = (): Record<string, string> => {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    const keys = JSON.parse(text) as unknown;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error(`${shown} is not a JSON object of labels and keys`);
    return keys as Record<string, string>;
  };
  return {
    holder: `the laptop inbox on ${machine}, in ${shown}, which only its user reads`,
    save: async (label, key) => { writePrivate(file, `${JSON.stringify({ ...read(), [label]: base32Encode(key) }, null, 2)}\n`); },
    load: async (label) => {
      const keys = read();
      return Object.hasOwn(keys, label) ? base32Decode(String(keys[label])) : undefined;
    },
    remove: async (label) => {
      const keys = read();
      if (!Object.hasOwn(keys, label)) return;
      delete keys[label];
      writePrivate(file, `${JSON.stringify(keys, null, 2)}\n`);
    },
  };
}
