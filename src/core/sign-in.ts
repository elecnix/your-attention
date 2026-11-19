// The short form of a sign-in code, which a person types on a phone where no link can be pasted, such as an iPhone
// Home Screen app. The long code in a link has 128 bits and needs no limit. The short one has 8 characters from 31,
// about 39.6 bits, so the inbox counts wrong guesses: see MAX_WRONG_SIGN_IN_CODES in inbox.ts.

/** Digits and capitals, without 0, 1, I, L and O, which read as one another. */
export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHORT_CODE_LENGTH = 8;

/** A uniformly random short code. Bytes past the largest multiple of the alphabet's size are drawn again. */
export function shortCode(): string {
  const n = SHORT_CODE_ALPHABET.length;
  const cap = 256 - (256 % n);
  let out = '';
  while (out.length < SHORT_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(SHORT_CODE_LENGTH))) {
      if (b < cap && out.length < SHORT_CODE_LENGTH) out += SHORT_CODE_ALPHABET[b % n];
    }
  }
  return out;
}

/** The short code a person typed, in capitals without spaces or dashes, or undefined when it cannot be one. */
export function readShortCode(typed: string): string | undefined {
  const s = String(typed ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (s.length !== SHORT_CODE_LENGTH) return undefined;
  for (const ch of s) if (!SHORT_CODE_ALPHABET.includes(ch)) return undefined;
  return s;
}
