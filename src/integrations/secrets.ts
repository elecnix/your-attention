// The secret widget for the harness integrations. card_post fills each placement's public key, and the private key
// stays in this process, so only the session that asked can open the answer. Each value goes to a file only this user
// can read, and the model gets the path, never the value.
import path from 'node:path';
import { isSealed, newSealKeys, openSealed, sealedFields } from '../core/sealed.ts';
import type { Answer, Card } from '../core/types.ts';
import type { Candidate, SecretQuery } from '../core/secret-sources.ts';
import { addToPlacements, placementValues } from '../core/widgets.ts';
import { homeDir, writePrivate } from '../node/home.ts';

export class SecretRequests {
  // card id -> the private keys of its posts, newest first. A revision makes a new key, and an answer sealed for an
  // earlier version still opens.
  private readonly keys = new Map<string, CryptoKey[]>();

  /** Fill the public key into each secret and secret_access widget the body places, with one key pair for the card.
   * A secret_access placement without `candidates` gets the candidates `lookup` finds for its `query`, or for its name
   * when it gives no query. `keep` holds the private key under the posted card's id. */
  async prepare(body: string | undefined, lookup?: (query: SecretQuery) => Promise<{ candidates: Candidate[] }>): Promise<{ body: string | undefined; count: number; keep: (id: string) => void }> {
    if (body === undefined || !/\bwidget\s+secret(_access)?\b/.test(body)) return { body, count: 0, keep: () => {} };
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
    const count = sealedOnly.count + access.count;
    if (!count) return { body, count: 0, keep: () => {} };
    return { body: access.body, count, keep: (id) => this.keys.set(id, [privateKey, ...(this.keys.get(id) ?? [])].slice(0, 10)) };
  }

  /** The lines for the model about each secret field of the card. They never contain a value. Empty for a card with
   * none. It never throws, since it runs inside the answer stream, and a failure there would stop the stream. */
  async receive(card: Card, answer: Answer): Promise<string> {
    const lines: string[] = [];
    for (const field of sealedFields(card)) {
      // A secret card that an older inbox stored names its value in `secret` and seals it in `sealed`.
      const name = card.kind === 'secret' && card.secret ? card.secret.name : field;
      const sealed = answer.values[field];
      if (!isSealed(sealed)) { lines.push(`The person did not send ${name} on card ${card.id}.`); continue; }
      const value = await this.open(card.id, sealed);
      if (value === undefined) {
        lines.push(`The person sent ${name} on card ${card.id}, but this session no longer has the key to open it. Ask again: post a new card that places the secret widget.`);
        continue;
      }
      const file = secretFile(card.agent, card.id, name);
      try {
        writePrivate(file, value);
      } catch (e) {
        lines.push(`The person sent ${name} on card ${card.id}, but this session could not write it to a file: ${(e as Error).message}. Ask again: post a new card that places the secret widget.`);
        continue;
      }
      lines.push(`The person sent ${name} on card ${card.id}. It is in ${file}, which only this user can read. Use it inside a command, such as "$(cat '${file}')", and never print it or write it into the conversation. Delete the file when you no longer need it.`);
    }
    return lines.join('\n');
  }

  private async open(id: string, sealed: Parameters<typeof openSealed>[1]): Promise<string | undefined> {
    for (const key of this.keys.get(id) ?? []) {
      try { return await openSealed(key, sealed); } catch { /* sealed for another version's key */ }
    }
    return undefined;
  }
}

/** Where the secret `name` from card `card` for `agent` is written. Each card has its own folder, so two cards that
 * ask for the same name keep two files. */
export function secretFile(agent: string, card: string, name: string): string {
  // A card id may hold a colon or be all dots, so its folder takes a prefix and the id percent-encoded.
  return path.join(homeDir(), 'secrets', agent.replace(/[^\w.-]/g, '_'), `card-${encodeURIComponent(card).replace(/\./g, '%2E')}`, name);
}
