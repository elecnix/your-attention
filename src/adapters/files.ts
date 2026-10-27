// File bytes on disk for the laptop build: one file per attachment, plus its type.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore } from '../core/storage.ts';

export class FileBlobs implements BlobStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  // encodeURIComponent turns ":" into "%3A", which every file system accepts.
  private file(key: string): string {
    return path.join(this.dir, encodeURIComponent(key));
  }

  async put(key: string, bytes: Uint8Array<ArrayBuffer>, type: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file(key), bytes, { mode: 0o600 });
    await fs.writeFile(`${this.file(key)}.type`, type, { mode: 0o600 });
  }

  async get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | undefined> {
    try {
      const [buf, type] = await Promise.all([fs.readFile(this.file(key)), fs.readFile(`${this.file(key)}.type`, 'utf8')]);
      return { bytes: new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as Uint8Array<ArrayBuffer>, type };
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    await Promise.all([fs.rm(this.file(key), { force: true }), fs.rm(`${this.file(key)}.type`, { force: true })]);
  }
}
