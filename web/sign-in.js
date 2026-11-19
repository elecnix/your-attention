// The sign-in field of a signed-out page, for a device with no address bar, such as an iPhone Home Screen app.
// It takes a whole sign-in link, its code, or the short code the phone dialog shows. The inbox reads the code itself.

/** What a person typed or pasted, as the body of POST /v1/login, or null when the field is empty. */
export function readSignIn(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = /[#&](signin|token)=([^&\s]+)/.exec(s);
  if (m) {
    // A broken escape, from a link cut short, stays as typed, and the inbox refuses it in its own words.
    let value = m[2];
    try { value = decodeURIComponent(value); } catch {}
    return m[1] === 'token' ? { token: value } : { code: value };
  }
  return { code: s };
}

/** A short code in two groups of four, which reads and types more easily than eight in a row. */
export function groupCode(short) {
  return `${short.slice(0, 4)}-${short.slice(4)}`;
}
