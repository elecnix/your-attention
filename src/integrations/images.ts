// Images the person pasted into an answer. The integration downloads each one into a folder only this user can read,
// and the model gets the paths, as it gets a secret's path, so it can open the files.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.ts';
import type { Answer, Attachment } from '../core/types.ts';
import { homeDir } from '../node/home.ts';

/** One folder name an agent or a card id can be, with nothing in it that walks up a level. */
function folder(name: string): string {
  const clean = name.replace(/[^\w.-]/g, '_');
  // `.` and `..` name folders rather than files, so a card id or an agent name of `..` would climb out of the tree.
  return clean === '' || clean === '.' || clean === '..' ? '_' : clean;
}

/** Where the images of `card` answered for `agent` are written. */
export function imagesDir(agent: string, card: string): string {
  return path.join(homeDir(), 'images', folder(agent), folder(card));
}

/** Save the answer's images and return their paths, in order. A file that can't be fetched gets a line saying so. */
export async function saveAnswerImages(inbox: Pick<Client, 'attachment'>, agent: string, answer: Answer): Promise<string[]> {
  const images = answer.images ?? [];
  if (!images.length) return [];
  try {
    const dir = imagesDir(agent, answer.card);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return await Promise.all(images.map(async (f: Attachment, i) => {
      const file = path.join(dir, `${answer.savedAt}-${i + 1}-${(f.name || 'image').replace(/[^\w.-]/g, '_')}`);
      try {
        fs.writeFileSync(file, await inbox.attachment(f.id ?? ''), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
        return file;
      } catch (e) {
        return `${f.name} (could not be fetched: ${(e as Error).message})`;
      }
    }));
  } catch (e) {
    // The answer always reaches the agent. Every caller awaits this while building the text it sends, so a folder or a
    // path that cannot be made costs the images, not the answer: each one becomes a line the model reads.
    return images.map((f) => `${f.name || 'an image'} (could not be saved: ${(e as Error).message})`);
  }
}
