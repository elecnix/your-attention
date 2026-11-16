import type { CardSummary } from '../src/core/summary.ts';
import type { Presence } from '../src/core/types.ts';

/** What the inbox says about one agent: connected, offline, or never heard from. */
export type ListedAgentStatus = 'online' | 'offline' | 'unknown';

/** One agent, as the panel that sends it a card lists it. */
export interface ListedAgent {
  id: string;
  /** The session name the agent reports on its newest card, else its id. */
  name: string;
  /** The working directory a card carried, when the inbox has one. */
  cwd: string | null;
  /** The herdr pane the session reported with its connection, when presence carries one. */
  pane: string | null;
  online: boolean;
  /** When the inbox last saw this agent, or null while it is connected or when it never connected. */
  lastSeen: number | null;
  /** The session drops channel notifications, so a card pushed there never reaches its model. */
  channelOff: boolean;
  status: ListedAgentStatus;
  /** The agent's state as the person reads it, such as `Connected now` or `Last seen 4 h 30 min ago`. */
  label: string;
}

export function agentList(state: { cards?: CardSummary[]; presence?: Record<string, Presence> }, now?: number): ListedAgent[];

/** The agents whose name, id, working directory or pane carries the search, in the order the list has them. A match
 * reads anywhere in a field and ignores case, and an empty search keeps every agent. */
export function searchAgents(agents: ListedAgent[], query: string): ListedAgent[];

/** The agent a pick reads as: the picked one while the list still has it, else the first of the list, else null. */
export function pickedAgent(agents: ListedAgent[], picked: string | null): ListedAgent | null;
