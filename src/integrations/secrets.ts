// The secret widgets for the harness integrations. card_post fills each placement's public key, and the private key
// stays in this process, so only the session that asked can open the answer. Each value opens in memory into the
// session's grant store, and the harness adds it to the environment of each command it starts while the grant lives.
// Nothing here writes a value to a file, and the model gets the variable's name, never the value or a path.
import { GRANT_DEFAULT_MS, GRANT_IDLE_MS, type AccessGrant, type Candidate, type SecretQuery } from '../core/secret-sources.ts';
import { isSealed, newSealKeys, openSealed, sealedFields } from '../core/sealed.ts';
import type { Answer, Card } from '../core/types.ts';
import { addToPlacements, placementValues } from '../core/widgets.ts';
import { Grants } from '../secrets/grant.ts';
import { MIN_MASKED, Redactor, type StreamMask } from '../secrets/redact.ts';

/** A name the shells read as a variable. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isDecline = (v: unknown): boolean => Boolean(v && typeof v === 'object' && (v as { decline?: unknown }).decline === true);
const isAccessGrant = (v: unknown): v is AccessGrant => {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  return typeof g['grant'] === 'string' && typeof g['until'] === 'number' && typeof g['case'] === 'string' && isSealed(g['sealed']);
};

export class SecretRequests {
  // card id -> the private keys of its posts, newest first. A revision makes a new key, and an answer sealed for an
  // earlier version still opens.
  private readonly keys = new Map<string, CryptoKey[]>();
  private readonly grants: Grants;
  private readonly redactor = new Redactor();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.grants = new Grants(now);
  }

  /** Fill the public key into each secret and secret_access widget the body places, with one key pair for the card.
   * A secret_access placement without `candidates` gets the candidates `lookup` finds for its `query`, or for its name
   * when it gives no query. `keep` holds the private key under the posted card's id. */
  async prepare(body: string | undefined, lookup?: (query: SecretQuery) => Promise<{ candidates: Candidate[] }>): Promise<{ body: string | undefined; count: number; keep: (id: string) => void }> {
    if (body === undefined || !/\bwidget\s+(secret(_access)?|otp)\b/.test(body)) return { body, count: 0, keep: () => {} };
    const asks = placementValues(body, 'secret_access');
    const found: (string | undefined)[] = [];
    for (const vars of asks) {
      if (vars['candidates'] !== undefined) { found.push(typeof vars['candidates'] === 'string' ? undefined : JSON.stringify(vars['candidates'])); continue; }
      const query = vars['query'] && typeof vars['query'] === 'object' ? vars['query'] as SecretQuery : { name: String(vars['name'] ?? '') };
      if (!lookup) throw new Error(`secret ${String(vars['name'])}: this session cannot look up candidates, so give them in candidates`);
      let result;
      try { result = await lookup(query); } catch (e) { throw new Error(`could not look up the candidates for ${String(vars['name'])}: ${(e as Error).message}`); }
      found.push(JSON.stringify(result.candidates));
    }
    const { publicKey, privateKey } = await newSealKeys();
    const key = JSON.stringify(publicKey);
    const sealedOnly = addToPlacements(body, 'secret', { publicKey: key });
    const access = addToPlacements(sealedOnly.body, 'secret_access', (_vars, i) => ({ publicKey: key, ...(found[i] === undefined ? {} : { candidates: found[i] }) }));
    // A one-time code is sealed to the same key, when the session redeems the ticket the person's approval gave it.
    const codes = addToPlacements(access.body, 'otp', { publicKey: key });
    const count = sealedOnly.count + access.count + codes.count;
    if (!count) return { body, count: 0, keep: () => {} };
    return { body: codes.body, count, keep: (id) => this.remember(id, privateKey) };
  }

  /** Keep the private key of a card's post, newest first, so an answer sealed for an earlier version still opens. */
  remember(id: string, privateKey: CryptoKey): void {
    this.keys.set(id, [privateKey, ...(this.keys.get(id) ?? [])].slice(0, 10));
  }

  /** The lines for the model about each secret field of the card. They never contain a value or a path. Empty for a
   * card with none. Each value the person granted or typed goes into the session's grant store, and from there into
   * the environment of the commands the harness starts. It never throws, since it runs inside the answer stream, and
   * a failure there would stop the stream. */
  async receive(card: Card, answer: Answer): Promise<string> {
    return (await this.receiveDetail(card, answer)).text;
  }

  /** As `receive`, with the names this answer granted, so a harness can add a line about its commands only then. */
  async receiveDetail(card: Card, answer: Answer): Promise<{ text: string; granted: string[] }> {
    const lines: string[] = [];
    const granted: string[] = [];
    for (const field of sealedFields(card)) {
      // A secret card that an older inbox stored names its value in `secret` and seals it in `sealed`.
      const name = card.kind === 'secret' && card.secret ? card.secret.name : field;
      const value = answer.values[field];
      // A decline or a revoke is the newest decision about this name, so it ends a grant an earlier card gave.
      if (isDecline(value)) { this.grants.end(card.agent, name); lines.push(`The person declined access to ${name} on card ${card.id}, so this session has no ${name}.`); continue; }
      const access = isAccessGrant(value) ? value : undefined;
      const sealed = access ? access.sealed : value;
      if (!isSealed(sealed)) { lines.push(`The person did not send ${name} on card ${card.id}.`); continue; }
      if (access?.revokedAt !== undefined) { this.grants.end(card.agent, name); lines.push(`The person revoked ${name} on card ${card.id} (case ${access.case}), so this session has no ${name}.`); continue; }
      if (!ENV_NAME.test(name)) { lines.push(`The person sent ${name} on card ${card.id}, but a shell variable can't take that name. Ask again with a name of letters, digits and underscores.`); continue; }
      const plain = await this.open(card.id, sealed);
      if (plain === undefined) {
        lines.push(`The person sent ${name} on card ${card.id}, but this session no longer has the key to open it. Ask again: post a new card that asks for it.`);
        continue;
      }
      const now = this.now();
      // A value typed on the card lasts an hour from the person's answer, as a grant with the default ceiling does. A
      // clock that runs behind the inbox's never makes the hour start later than now.
      const until = access ? access.until : Math.min(answer.savedAt ?? now, now) + GRANT_DEFAULT_MS;
      // An answer can reach the session after its ceiling, such as one queued while the session was away. An expired
      // answer is no decision against the name, so a live grant another card gave for it stays.
      if (until <= now) {
        this.redactor.add(name, plain);
        const which = access ? ` (case ${access.case})` : '';
        lines.push(`The grant of ${name} on card ${card.id}${which} ended at ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC, before it reached this session, so this session has no ${name}. Ask again if you still need it.`);
        continue;
      }
      const grant = this.grants.hold({
        name,
        agent: card.agent,
        value: plain,
        until,
        idleMs: GRANT_IDLE_MS,
        now,
        ...(access ? { caseId: access.case } : {}),
      });
      this.redactor.add(name, plain);
      granted.push(name);
      const mask = plain.length < MIN_MASKED
        ? `${name} is shorter than ${MIN_MASKED} characters, so output that shows it is not masked.`
        : `Output that shows the value reads [secret ${name}].`;
      lines.push(`${this.grants.describe(grant)} Every command you run gets it as $${name} in its environment: write "$${name}" in the command, and never print the value or write it to a file. ${mask}`);
    }
    return { text: lines.join('\n'), granted };
  }

  /** Open a one-time code the inbox sealed to a card's key, and hold it as a grant of `name` until the end of the
   * code's step, so the next command gets it as $NAME. The line for the model names the variable and the deadline,
   * never the code or a path. Undefined when this session no longer has the card's key. */
  async holdCode(card: string, agent: string, name: string, sealed: Parameters<typeof openSealed>[1], until: number): Promise<string | undefined> {
    const plain = await this.open(card, sealed);
    if (plain === undefined) return undefined;
    const now = this.now();
    this.grants.hold({ name, agent, value: plain, until, idleMs: GRANT_IDLE_MS, now });
    this.redactor.add(name, plain);
    const left = Math.max(0, Math.round((until - now) / 1000));
    return `$${name} holds a fresh one-time code until ${new Date(until).toISOString().slice(11, 19)} UTC, ${left} seconds from now. Run the command that needs it at once, with "$${name}" in it, such as --otp "$${name}". Never print the code or write it to a file. Output that shows it reads [secret ${name}].`;
  }

  /** The live grants of `agent` as `{NAME: value}`, for the environment of one command it is about to start. Each
   * counts as a use, so its idle window restarts. */
  env(agent: string): Record<string, string> {
    return this.grants.env(agent, this.now());
  }

  /** The names `agent` holds a live grant for now, without using one. */
  names(agent: string): string[] {
    return this.grants.names(agent, this.now());
  }

  /** Whether `agent` holds a live grant now, without using one. */
  holds(agent: string): boolean {
    return this.grants.names(agent, this.now()).length > 0;
  }

  /** Ends the grant with this case id, so the next command no longer gets it. Says whether one was live. */
  revoke(caseId: string): boolean {
    return this.grants.revoke(caseId);
  }

  /** `text` with every value this session received masked as `[secret NAME]`. */
  mask(text: string): string {
    return this.redactor.mask(text);
  }

  /** Every string inside `value`, masked, for a tool result shaped as an object. */
  maskDeep<T>(value: T): T {
    return this.redactor.maskDeep(value);
  }

  /** A masker for a command's output as it streams, so a value is masked before anything stores or shows it. */
  stream(): StreamMask {
    return this.redactor.stream();
  }

  /** Whether this session ever received a value, so a caller can skip masking. */
  get received(): boolean {
    return !this.redactor.empty;
  }

  private async open(id: string, sealed: Parameters<typeof openSealed>[1]): Promise<string | undefined> {
    for (const key of this.keys.get(id) ?? []) {
      try { return await openSealed(key, sealed); } catch { /* sealed for another version's key */ }
    }
    return undefined;
  }
}
