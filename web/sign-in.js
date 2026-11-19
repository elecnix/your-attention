// The sign-in field of a signed-out page, for a device with no address bar, such as an iPhone Home Screen app.
// It takes a whole sign-in link, its code, or the short code the phone dialog shows. The inbox reads the code itself.

/** What a person typed or pasted, as the body of POST /v1/login, or null when the field is empty. */
export function readSignIn(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = /[#&](signin|token)=([^&\s]+)/.exec(s);
  if (m) return m[1] === 'token' ? { token: decodeURIComponent(m[2]) } : { code: decodeURIComponent(m[2]) };
  return { code: s };
}

/** A short code in two groups of four, which reads and types more easily than eight in a row. */
export function groupCode(short) {
  return `${short.slice(0, 4)}-${short.slice(4)}`;
}
