// A session link points at another agent's session from inside a card. It uses herdr's own link form,
// https://herdr.invalid/v1/<kind>/<id>, which agents already write in their terminal replies.
// A link may carry herdr's session fingerprint before the kind; the inbox ignores it.

export type SessionKind = 'agent' | 'pane' | 'tab' | 'workspace';

const LINK = /^https:\/\/herdr\.invalid\/v1\/(?:[0-9a-f]{64}\/)?(agent|pane|tab|workspace)\/([A-Za-z0-9][\w:.-]{0,99})$/;

/** The session a link points at, or undefined when the address is not a session link. An id never starts with a dash, so herdr cannot read it as a flag. */
export function parseSessionLink(href: string): { kind: SessionKind; id: string } | undefined {
  const m = LINK.exec(href);
  return m ? { kind: m[1] as SessionKind, id: m[2] as string } : undefined;
}
