// Where a Claude Code session's stretch of inactivity lives. The Stop hook starts it, the prompt and session-end hooks
// end it, and the channel reads it to time its asks. Each hook runs as its own process, so the stretch needs a file,
// and the file is also what lets a channel that restarts carry on with a stretch already under way.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../node/home.ts';
import { isStretch, type Stretch, type StretchStore } from '../card-asks.ts';

export function stretchFile(session: string): string {
  return path.join(homeDir(), 'claude', `${session}.card-ask`);
}

export function fileStore(session: string): StretchStore {
  const file = stretchFile(session);
  return {
    load(): Stretch | undefined {
      try {
        const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return isStretch(v) ? v : undefined;
      } catch {
        return undefined;
      }
    },
    save(stretch: Stretch | undefined): void {
      if (!stretch) return void fs.rmSync(file, { force: true });
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // A rename replaces the file whole, so the channel never reads half of a hook's write.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(stretch), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/** Something happened in the session: the person spoke, an answer arrived, or the session ended. */
export function endStretch(session: string): void {
  fileStore(session).save(undefined);
}
