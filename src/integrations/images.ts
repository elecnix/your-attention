// Images the person pasted into an answer. The integration downloads each one into a folder only this user can read,
// and the model gets the paths, as it gets a secret's path, so it can open the files.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.ts';
import type { Answer } from '../core/types.ts';
import { homeDir } from '../node/home.ts';

/** Where the images of `card` answered for `agent` are written. */
export function imagesDir(agent: string, card: string): string {
  return path.join(homeDir(), 'images', agent.replace(/[^\w.-]/g, '_'), card.replace(/[^\w.-]/g, '_'));
}

/** Save the answer's images and return their paths, in order. A file that can't be fetched gets a line saying so. */
export async function saveAnswerImages(inbox: Pick<Client, 'attachment'>, agent: string, answer: Answer): Promise<string[]> {
  const images = answer.images ?? [];
  if (!images.length) return [];
  const dir = imagesDir(agent, answer.card);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Promise.all(images.map(async (f, i) => {
    const file = path.join(dir, `${answer.savedAt}-${i + 1}-${(f.name || 'image').replace(/[^\w.-]/g, '_')}`);
    try {
      fs.writeFileSync(file, await inbox.attachment(f.id ?? ''), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return file;
    } catch (e) {
      return `${f.name} (could not be fetched: ${(e as Error).message})`;
    }
  }));
}
