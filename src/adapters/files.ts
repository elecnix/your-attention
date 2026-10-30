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

/** A file on this machine, by the decoded path of its file: address, for the laptop inbox's file links. A directory, a
 * missing file or anything else that is not a regular file is undefined. The caller reads the bytes after it checks the size. */
export async function localFile(name: string): Promise<{ size: number; read(): Promise<Uint8Array<ArrayBuffer>> } | undefined> {
  // A file: address on Windows has a path like /C:/Users/me, with a slash before the drive.
  const file = process.platform === 'win32' ? path.normalize(name.replace(/^\/(?=[A-Za-z]:)/, '')) : name;
  if (!path.isAbsolute(file)) return undefined;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return undefined;
    return {
      size: stat.size,
      async read() {
        const buf = await fs.readFile(file);
        return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as Uint8Array<ArrayBuffer>;
      },
    };
  } catch {
    return undefined;
  }
}
