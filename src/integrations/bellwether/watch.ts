// `your-attention bellwether`: read each retirement Bellwether appends to retire.log, and hand the cards of the retired
// agent, and of its descendants that no longer run, to the nearest living ancestor.
//
// Only a retirement triggers a move. A stream that disconnects is not one: a parent that closes a laptop, or a daemon
// that restarts, looks the same to the inbox as a child that finished, and only Bellwether knows the difference.
//
// The seam is Bellwether's files: the parent records under parents/ and the append-only retire.log. A command,
// `bellwether ancestry <agent> --json`, would be the better one, because its daemon also knows whether a root session is
// connected, which no file records. Until that command exists, the watcher reads the files, and a root counts as alive
// while the inbox shows its session connected or gone less than the hour after which a card reads orphaned.
import fs from 'node:fs';
import path from 'node:path';
import type { CardState, Presence } from '../../core/types.ts';
import { planRetirement, Tree, type BellwetherParent, type Move, type PlannedCard } from './ancestry.ts';

/** One line of retire.log. */
export interface Retirement {
  at: string;
  parent: string;
  child: string;
  name: string;
}

/** The owner calls the watcher makes, over HTTP or on the inbox itself. */
export interface ReassignInbox {
  state(): Promise<{ cards: PlannedCard[]; states: Record<string, CardState>; presence: Record<string, Presence> }>;
  reassign(id: string, input: { to: string | null; why: string }): Promise<unknown>;
}

/** Bellwether's home: BELLWETHER_HOME, or ~/.bellwether. */
export function bellwetherHome(env: NodeJS.ProcessEnv = process.env, home = env['HOME'] ?? ''): string {
  return env['BELLWETHER_HOME'] || path.join(home, '.bellwether');
}

/** Every parent record in the home. A file that does not parse, such as one Bellwether is writing, is left out. */
export function readParents(home: string): BellwetherParent[] {
  const dir = path.join(home, 'parents');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: BellwetherParent[] = [];
  for (const name of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as BellwetherParent;
      if (r && typeof r.id === 'string' && Array.isArray(r.children)) out.push(r);
    } catch {
      // Bellwether rewrites a record whole, so the next read gets it.
    }
  }
  return out;
}

/** Where the watcher stopped reading retire.log: the file's inode and the byte after the last whole line. */
export interface Cursor {
  ino: number;
  offset: number;
}

/** The retirements appended after `cursor`, and the cursor after them. A log that was rotated, or that shrank, is read
 * from its start. A line still being written waits for the next read. */
export function readRetirements(home: string, cursor: Cursor | undefined): { retirements: Retirement[]; cursor: Cursor } {
  const file = path.join(home, 'retire.log');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { retirements: [], cursor: cursor ?? { ino: 0, offset: 0 } };
  }
  const from = cursor && cursor.ino === stat.ino && cursor.offset <= stat.size ? cursor.offset : 0;
  if (from === stat.size) return { retirements: [], cursor: { ino: stat.ino, offset: from } };
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(stat.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const end = text.lastIndexOf('\n') + 1;
  const retirements: Retirement[] = [];
  for (const line of text.slice(0, end).split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<Retirement>;
      if (typeof r.child === 'string' && typeof r.name === 'string') retirements.push({ at: String(r.at ?? ''), parent: String(r.parent ?? ''), child: r.child, name: r.name });
    } catch {
      // A line that is not JSON names no child.
    }
  }
  return { retirements, cursor: { ino: stat.ino, offset: from + Buffer.byteLength(text.slice(0, end)) } };
}

/** Apply one retirement: read the tree and the inbox now, plan, and reassign each card. Answers the moves it made. */
export async function applyRetirement(inbox: ReassignInbox, home: string, retired: Pick<Retirement, 'child' | 'name'>, now: number): Promise<Move[]> {
  const { cards, states, presence } = await inbox.state();
  const moves = planRetirement({ tree: new Tree(readParents(home)), retired, cards, states, presence, now });
  for (const m of moves) await inbox.reassign(m.card, { to: m.to ?? null, why: m.why });
  return moves;
}

/** One line for a move, as the watcher logs it. */
export function describeMove(m: Move): string {
  return m.to ? `card ${m.card}: ${m.from} to ${m.to}, because ${m.why}` : `card ${m.card}: left to the person, because ${m.why} and no ancestor of ${m.from} is alive`;
}

/** Read the cursor the watcher saved, or none. */
function loadCursor(file: string): Cursor | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Cursor>;
    return typeof c.ino === 'number' && typeof c.offset === 'number' ? { ino: c.ino, offset: c.offset } : undefined;
  } catch {
    return undefined;
  }
}

function saveCursor(file: string, cursor: Cursor): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read retire.log from where the last run stopped, apply each retirement, and save the cursor after the pass. A pass
 * that fails, as when the inbox does not answer, starts again from the same place, and a retirement it already applied
 * plans no move the second time. The first run reads the whole log for the same reason. With `once`, return after one
 * pass. */
export async function watchRetirements(opts: {
  inbox: ReassignInbox;
  home: string;
  cursorFile: string;
  signal: AbortSignal;
  log: (line: string) => void;
  now?: () => number;
  intervalMs?: number;
  once?: boolean;
}): Promise<void> {
  const now = opts.now ?? Date.now;
  let cursor = loadCursor(opts.cursorFile);
  const pass = async (): Promise<void> => {
    const read = readRetirements(opts.home, cursor);
    for (const r of read.retirements) {
      const moves = await applyRetirement(opts.inbox, opts.home, r, now());
      for (const m of moves) opts.log(describeMove(m));
    }
    cursor = read.cursor;
    saveCursor(opts.cursorFile, cursor);
  };
  if (opts.once) return pass();
  while (!opts.signal.aborted) {
    await pass().catch((e: unknown) => opts.log(`retire.log: ${(e as Error).message}`));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.intervalMs ?? 2000);
      opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
