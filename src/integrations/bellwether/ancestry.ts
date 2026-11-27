// The chain of ancestors of an agent, read from the parent records Bellwether writes, and the plan that hands each card
// of a retired agent to its nearest living ancestor. Nothing here reads a file or calls the inbox: watch.ts does both.
//
// Identity: a card names its agent as `<harness>:<session id>` (`claude:…`, `pi:…`, `opencode:…`), the session the
// harness itself reports. Bellwether writes the same session on each child record (`session.value`, a path for pi whose
// file name ends in the id) and on each parent record (`session`). So the match is on the harness and the session id,
// and needs no new field on either side. A child's name, its `agentName` and a handle such as `cc-swift-koala-42` are
// labels that two children can share, and a card never carries Bellwether's own child id.

import { leftWithoutAgent, ORPHAN_MS } from '../../core/inbox.ts';
import type { Presence, Reassignment } from '../../core/types.ts';

/** A child as Bellwether records it in its parent's file: the fields this module reads. */
export interface BellwetherChild {
  id: string;
  name: string;
  harness?: string;
  session?: { kind: string; value: string };
  startedAt?: string;
  resumedAt?: string;
  exitedAt?: string;
  retiredAt?: string;
}

/** One file under ~/.bellwether/parents: a session that started children, and the child id it has itself, if any. */
export interface BellwetherParent {
  id: string;
  harness: string;
  session: string;
  childId?: string;
  children: BellwetherChild[];
}

/** One agent in a chain, from the card's agent upward. `alive` is what Bellwether says about a child: true until it
 * exits. A root session is no one's child, so Bellwether's files do not say whether it still runs, and `alive` is
 * undefined: the caller decides with the inbox's own presence. */
export interface Link {
  agent: string;
  /** The name the parent gave the child. A root has none. */
  name?: string;
  /** Bellwether's id for the child. A root has none. */
  childId?: string;
  alive?: boolean;
}

const HARNESS_PREFIX: Record<string, string> = { 'claude-code': 'claude', pi: 'pi', opencode: 'opencode' };

/** The session id a child record names. Pi records the session file, whose name ends in `_<id>.jsonl`. */
export function sessionId(session: { kind: string; value: string } | undefined): string | undefined {
  if (!session?.value) return undefined;
  if (session.kind !== 'path') return session.value;
  const file = session.value.split('/').pop() ?? '';
  return file.replace(/\.jsonl$/, '').split('_').pop() || undefined;
}

/** The agent id a card carries for a harness session, or undefined for a harness without an integration. */
export function agentOf(harness: string | undefined, session: string | undefined): string | undefined {
  const prefix = harness ? HARNESS_PREFIX[harness] : undefined;
  return prefix && session ? `${prefix}:${session}` : undefined;
}

interface Entry {
  child: BellwetherChild;
  parent: BellwetherParent;
}

const startedOf = (c: BellwetherChild): number => Date.parse(c.resumedAt ?? c.startedAt ?? '') || 0;

/** The record that answers to an agent id when more than one does, as a session resumed or moved under a new record:
 * the one Bellwether shows running, then the one started or resumed last. Bellwether refuses to run one session in two
 * panes, so two running records for one session do not occur. */
function pick(entries: Entry[]): Entry | undefined {
  return [...entries].sort((a, b) => Number(!a.child.exitedAt) - Number(!b.child.exitedAt) || startedOf(a.child) - startedOf(b.child)).pop();
}

/** An index of the tree, by agent id and by child id. */
export class Tree {
  private readonly byAgent = new Map<string, Entry[]>();
  private readonly byChildId = new Map<string, Entry>();
  private readonly roots = new Map<string, BellwetherParent>();

  constructor(parents: BellwetherParent[]) {
    for (const parent of parents) {
      const self = agentOf(parent.harness, parent.session);
      if (self) this.roots.set(self, parent);
      for (const child of parent.children ?? []) {
        const entry = { child, parent };
        this.byChildId.set(child.id, entry);
        const agent = agentOf(child.harness, sessionId(child.session));
        if (agent) this.byAgent.set(agent, [...(this.byAgent.get(agent) ?? []), entry]);
      }
    }
  }

  /** The child record of an agent, and the record of its parent. */
  private entryOf(agent: string, childId?: string): Entry | undefined {
    return (childId ? this.byChildId.get(childId) : undefined) ?? pick(this.byAgent.get(agent) ?? []);
  }

  /** The chain from the agent up to the root of its tree, or undefined when Bellwether does not know the agent. */
  ancestry(agent: string): Link[] | undefined {
    if (!this.byAgent.has(agent) && !this.roots.has(agent)) return undefined;
    const chain: Link[] = [];
    const seen = new Set<string>();
    let current: string | undefined = agent;
    let childId: string | undefined;
    while (current && !seen.has(current)) {
      seen.add(current);
      const entry = this.entryOf(current, childId);
      if (!entry) {
        chain.push({ agent: current });
        break;
      }
      const { child, parent } = entry;
      chain.push({ agent: current, name: child.name, childId: child.id, alive: !child.exitedAt && !child.retiredAt });
      current = agentOf(parent.harness, parent.session);
      childId = parent.childId;
    }
    return chain;
  }
}

/** Whether the inbox counts a root as alive: its stream is connected, or left less than the hour after which the inbox
 * reads its cards as orphaned. This chooses where a card goes and never triggers anything: only a retirement does. */
export function presentRoot(p: Presence | undefined, now: number): boolean {
  if (!p) return false;
  // A closed connection keeps the row online for a short grace, with the moment it left in `leftAt`.
  if (p.online && p.leftAt === undefined) return true;
  return now - (p.leftAt ?? p.lastSeen) <= ORPHAN_MS;
}

/** A card the plan reads, whole or as the summary GET /v1/state sends. */
export interface PlannedCard {
  id: string;
  agent: string;
  kind: string;
  deliver: string;
  reassignedFrom?: Reassignment[];
  lastReassignment?: Reassignment;
}

/** What to do with one card: give it to `to`, or, with no `to`, leave it to the person. */
export interface Move {
  card: string;
  from: string;
  to?: string;
  why: string;
}

const WAITING = new Set(['in-triage', 'held', 'open', 'orphaned', 'answered', 'delivered']);

/** The moves one retirement makes. A card moves when its agent is the retired child or a descendant of it, and its own
 * agent no longer runs. It goes to the nearest living ancestor above that agent, and with none, it waits on the person. */
export function planRetirement(input: {
  tree: Tree;
  retired: { child: string; name: string };
  cards: PlannedCard[];
  states: Record<string, string>;
  presence: Record<string, Presence>;
  now: number;
}): Move[] {
  const { tree, retired, cards, states, presence, now } = input;
  const alive = (l: Link): boolean => l.alive ?? presentRoot(presence[l.agent], now);
  const moves: Move[] = [];
  for (const card of cards) {
    if (card.kind === 'system' || card.deliver !== 'stream' || !WAITING.has(states[card.id] ?? '')) continue;
    // A card already left to the person for this agent stays there: a retirement read twice changes nothing.
    if (leftWithoutAgent(card)) continue;
    const chain = tree.ancestry(card.agent);
    if (!chain || !chain.some((l) => l.childId === retired.child)) continue;
    // A descendant that still runs keeps its card: its parent retiring changes nothing for it.
    if (chain[0]!.alive) continue;
    const to = chain.slice(1).find(alive)?.agent;
    moves.push({ card: card.id, from: card.agent, ...(to ? { to } : {}), why: `${retired.name} retired` });
  }
  return moves;
}
