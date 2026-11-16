// The agents this inbox knows, as the panel that sends one a card lists them: the name each connection reported, the
// working directory a card carried, the pane presence reported, and when the inbox last saw it. Only presence says an
// agent is connected, so an agent that went offline reads as offline, whatever its cards say.
import { cardAge } from './age.js';
import { agentName } from './queue.js';

/** The agent id the inbox itself posts under, which is no session to send a card to. */
const SYSTEM_AGENT = 'system';

/** The agents of GET /v1/state, connected ones first, then the one seen most recently, then by the name each reports. */
export function agentList(state, now = Date.now()) {
  const cards = state.cards || [];
  const presence = state.presence || {};
  const rows = [];
  for (const id of new Set([...Object.keys(presence), ...cards.map((c) => c.agent)])) {
    if (!id || id === SYSTEM_AGENT) continue;
    const p = presence[id];
    const online = !!p && p.online === true;
    // An agent whose presence row the inbox pruned, and one that never connected, have no time to show.
    const lastSeen = online ? null : (p && (p.leftAt ?? p.lastSeen)) || null;
    // A session that has posted no card still has a name, because presence keeps the one its connection sent.
    rows.push({
      id,
      name: reported.name || agentName(id, cards, presence),
      cwd: reported.cwd || newestCwd(cards, id),
      // A pane is where a connection reported its session, so only presence knows one.
      pane: (p && p.origin && p.origin.herdrPane) || null,
      online,
      lastSeen,
      channelOff: !!p && p.channelOff === true,
      status: online ? 'online' : lastSeen === null ? 'unknown' : 'offline',
      label: online
        ? (p.channelOff ? 'Connected, but its session drops channel notifications' : 'Connected now')
        : lastSeen === null ? 'Never connected' : `Last seen ${cardAge(now - lastSeen)}`,
    });
  }
  return rows.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.name.localeCompare(b.name));
}

/** The working directory of the newest card of this agent that carried one. A presence row keeps no directory, so a
 * card is where the panel learns it. */
function newestCwd(cards, id) {
  let cwd = null;
  let at = -Infinity;
  for (const c of cards) {
    if (c.agent !== id) continue;
    const o = c.origin || {};
    const when = c.createdAt || 0;
    if (o.cwd && when >= at) { cwd = o.cwd; at = when; }
  }
  return cwd;
}

/** The agents whose name, id, working directory or pane carries this search, in the order the list has them, so the
 * panel filters as the person types without moving a row. A match reads anywhere in a field, never only at its start,
 * and it ignores case. An empty search keeps every agent. */
export function searchAgents(agents, query) {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) => [a.name, a.id, a.cwd, a.pane].some((v) => !!v && v.toLowerCase().includes(q)));
}

/** The agent a pick reads as: the one the person picked while the list still has it, else the first of the list.
 * An agent that reads offline stays in the list, since a card sent to it waits for its session, so the pick keeps it;
 * only a pick that left the list falls back, rather than sending a card to a name the state dropped. With no agent at
 * all, there is nothing to send to. */
export function pickedAgent(agents, picked) {
  return agents.find((a) => a.id === picked) || agents[0] || null;
}
