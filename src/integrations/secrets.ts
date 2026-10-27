// Secret requests for the harness integrations. The private key stays in this
// process, so only the session that asked can open the answer. The value goes
// to a file only this user can read, and the model gets the path, never the value.
import path from 'node:path';
import type { Client } from '../client.ts';
import { isSealed, newSealKeys, openSealed } from '../core/sealed.ts';
import type { Answer, Card, NewCard } from '../core/types.ts';
import { homeDir, writePrivate } from '../node/home.ts';

export class SecretRequests {
  private readonly keys = new Map<string, CryptoKey>(); // card id -> private key

  /** Post a secret card. Returns the card id. */
  async ask(inbox: Client, card: Omit<NewCard, 'kind' | 'secret'> & { name: string }): Promise<string> {
    const { publicKey, privateKey } = await newSealKeys();
    const { name, ...rest } = card;
    const posted = await inbox.post({ ...rest, kind: 'secret', secret: { name, publicKey } });
    this.keys.set(posted.id, privateKey);
    return posted.id;
  }

  /** The message for the model about a secret answer. It never contains the value. */
  async receive(card: Card, answer: Answer): Promise<string> {
    const name = card.secret?.name ?? 'SECRET';
    const note = answer.comment ? `\nComment: ${answer.comment}` : '';
    const sealed = answer.values['sealed'];
    if (!isSealed(sealed)) return `The person did not send ${name} on card ${card.id}.${note}`;
    const key = this.keys.get(card.id);
    if (!key) return `The person sent ${name} on card ${card.id}, but this session no longer has the key to open it. Ask again with card_ask_secret.${note}`;
    const value = await openSealed(key, sealed);
    const file = secretFile(card.agent, name);
    writePrivate(file, value);
    return `The person sent ${name} on card ${card.id}. It is in ${file}, which only this user can read. Use it inside a command, such as "$(cat '${file}')", and never print it or write it into the conversation. Delete the file when you no longer need it.${note}`;
  }
}

/** Where the secret `name` for `agent` is written. */
export function secretFile(agent: string, name: string): string {
  return path.join(homeDir(), 'secrets', agent.replace(/[^\w.-]/g, '_'), name);
}
