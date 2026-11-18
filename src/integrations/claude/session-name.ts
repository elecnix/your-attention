// The name Claude Code shows for a session, read from its transcript, so a card
// can say which session asks instead of showing the session id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How much of the transcript one read takes at a time, so a transcript of tens of megabytes never becomes one string. */
const CHUNK = 1 << 20;

/**
 * A /rename or --name writes a custom-title record, and Claude Code keeps appending
 * ai-title records as it summarizes the session. The latest custom title wins, then
 * the latest generated one.
 *
 * The channel asks again on each beat of its stream, so a rename reaches the agent list without a reconnect. A
 * transcript only grows, so the reader keeps where it stopped: a transcript that did not change costs one stat, and
 * one that grew costs the bytes it gained. A transcript that shrank was replaced, and is read again from the start.
 */
export class SessionName {
  /** Every byte read from the transcript, for the test that keeps a large one from being read in full each time. */
  bytesRead = 0;
  private file: string | undefined;
  private offset = 0;
  /** The start of a record still being written, kept until its newline arrives. */
  private rest = Buffer.alloc(0);
  private custom: string | undefined;
  private generated: string | undefined;
  private readonly session: string;
  private readonly root: string;

  constructor(session: string, root = path.join(os.homedir(), '.claude', 'projects')) {
    this.session = session;
    this.root = root;
  }

  read(): string | undefined {
    if (!/^[\w-]+$/.test(this.session)) return undefined;
    this.file ??= this.find();
    if (!this.file) return undefined;
    let size: number;
    // A transcript that went away is looked for again, and read from its start wherever it turns up.
    try { size = fs.statSync(this.file).size; } catch { this.file = undefined; this.reset(); return undefined; }
    if (size < this.offset) this.reset();
    if (size > this.offset) this.scan(size);
    return this.name();
  }

  private name(): string | undefined {
    return this.custom ?? this.generated;
  }

  private find(): string | undefined {
    let dirs: string[];
    try { dirs = fs.readdirSync(this.root); } catch { return undefined; }
    for (const dir of dirs) {
      const f = path.join(this.root, dir, `${this.session}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  private reset(): void {
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.custom = undefined;
    this.generated = undefined;
  }

  private scan(size: number): void {
    let fd: number;
    try { fd = fs.openSync(this.file!, 'r'); } catch { return; }
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, size - this.offset));
      while (this.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.bytesRead += n;
        let data = this.rest.length ? Buffer.concat([this.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        let end: number;
        while ((end = data.indexOf(10)) >= 0) {
          this.line(data.subarray(0, end));
          data = data.subarray(end + 1);
        }
        // Copy the tail, since the next read reuses the buffer it points into.
        this.rest = Buffer.from(data);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private line(bytes: Buffer): void {
    // Most records are messages and tool results, so only a line that names a title is decoded and parsed.
    if (bytes.indexOf('-title"') < 0) return;
    try {
      const r = JSON.parse(bytes.toString('utf8')) as { type?: string; customTitle?: unknown; aiTitle?: unknown };
      if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) this.custom = r.customTitle.trim();
      if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim()) this.generated = r.aiTitle.trim();
    } catch {}
  }
}

/** The session's name, read once, for a hook that runs once and exits. */
export function claudeSessionName(session: string, root?: string): string | undefined {
  return new SessionName(session, root).read();
}
