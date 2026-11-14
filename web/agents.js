// The agents this inbox knows, as the panel that sends one a card lists them: the name each reports, the working
// directory a card carried, and when the inbox last saw it. Only presence says an agent is connected, so an agent that
// went offline reads as offline, whatever its cards say.
import { cardAge } from './age.js';

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
    const reported = reportedBy(cards, id);
    rows.push({
      id,
      name: reported.name || id,
      cwd: reported.cwd || null,
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

/** The session name, and the working directory, of the newest card of this agent that carried each one. */
function reportedBy(cards, id) {
  let name = null;
  let nameAt = -Infinity;
  let cwd = null;
  let cwdAt = -Infinity;
  for (const c of cards) {
    if (c.agent !== id) continue;
    const o = c.origin || {};
    const at = c.createdAt || 0;
    if (o.name && at >= nameAt) { name = o.name; nameAt = at; }
    if (o.cwd && at >= cwdAt) { cwd = o.cwd; cwdAt = at; }
  }
  return { name, cwd };
}
