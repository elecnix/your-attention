// The queue, built from the card summaries of GET /v1/state: each card's state, its priority level, the sections of the list, and the order Skip for now and Send
// answer move through. The page and the terminal client share this file, so both show the same queue.

export const CLOSED_LABEL = { retracted: 'Retracted by agent', 'self-answered': 'Answered by agent', 'answered-in-terminal': 'Answered in the terminal', resolved: 'No longer waiting', expired: 'Expired', returned: 'Sent back to its agent', dismissed: 'Dismissed' };
export const STATE_LABEL = { open: 'to answer', 'in-triage': 'being checked by triage', held: 'held by an extension', orphaned: 'its agent is gone', answered: 'stored', delivered: 'delivered', read: 'read', closed: 'closed' };
/** The ids of the sections that every Group by choice shows, so a collapsed one keeps its state across the choices. */
export const SECTION_ID = { system: 'section: system', outbox: 'section: outbox', sent: 'section: sent' };

// A group's id is its kind and value, such as tag: topic: billing. The ':' and '%' of a part are escaped, because an
// agent picks tag keys and values: without the escape, a tag named `section: outbox` would take the outbox's id.
const idPart = (s) => String(s).replace(/[%:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const groupId = (kind, ...parts) => [kind, ...parts.map(idPart)].join(': ');

// An agent's name for people: the name its connection reports, else the session name its newest card carries, else its
// id. A session that has posted no card still has a name, because presence keeps the one its connection sent. A system
// card an agent asked for carries that agent's session, so it names the agent in `proposedBy`, never the system.
export function agentName(id, cards, presence = {}) {
  const reported = presence[id] && presence[id].origin && presence[id].origin.name;
  if (reported) return reported;
  let best = null;
  for (const c of cards) if ((c.proposedBy || c.agent) === id && c.origin && c.origin.name && (!best || c.createdAt > best.createdAt)) best = c;
  return best ? best.origin.name : id;
}

export function presenceOf(card, state) {
  if (card.deliver === 'none') return null;
  const p = state.presence[card.agent];
  if (!p || !p.online) return ['off', 'Agent offline: your answer waits until its session resumes'];
  if (p.channelOff) return ['off', 'Channel off: this session started without the development-channels flag, so answers cannot reach it'];
  const unread = state.cards.some((c) => c.agent === card.agent && state.states[c.id] === 'delivered');
  return unread ? ['busy', 'Agent busy: it has an answer it has not read yet'] : ['on', 'Agent listening'];
}

/** How triage treated a card, for the badge in its header: `none` when no extension checked it, `done` when one did, and
 * `bypass` when a pass reported that a bypass code skipped the checks. The second value is the sentence the badge shows
 * as its tooltip. */
export function triageState(card) {
  const t = card.triage;
  const by = t && t.by ? t.by : 'an extension';
  if (t && t.bypass) return ['bypass', `Bypassed: ${by} ran no checks, because the agent used a bypass code`];
  if (!t || t.state === 'skipped') return ['none', `Not triaged: ${(t && t.reason) || 'no triage extension checked this card'}`];
  if (t.state === 'pending') return ['none', `Not triaged yet: ${by} is checking this card`];
  const why = String(t.reason || '').trim();
  const short = why && why.length <= 140 ? ` (${why.replace(/\.$/, '')})` : '';
  if (t.state === 'returned') return ['done', `Triaged by ${by}: it sent this card back to its agent${short}`];
  if (t.state === 'held') return ['done', `Triaged by ${by}: it held this card${short}`];
  return ['done', `Triaged by ${by}${short}`];
}

/** The queue for GET /v1/state, grouped by nothing, priority, agent or tag:<key>./** The queue for GET /v1/state, grouped by nothing, priority, agent or tag:<key>. `pins` lists the pins, oldest first: a tag pin as [key, value], an agent pin as {agent}. `collapsed` holds the ids of the groups the person muted, each the group's kind and value. */
/** Two pins are the same pin when they name the same tag and value, or the same agent. */
export const samePin = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a[0] === b[0] && a[1] === b[1] : !Array.isArray(a) && !Array.isArray(b) && a.agent === b.agent);

/** The pins with one pin and the neighbour it moves toward swapped, so its group goes one place up or down the queue.
 * The list comes back as it was when the pin is not in it or has nowhere to go, so a click at either end changes
 * nothing. The pins are the inbox's settings, oldest first, so the order also decides which pin a card that matches
 * two of them joins. */
export function movePin(pins, pin, delta) {
  const i = pins.findIndex((p) => samePin(p, pin));
  const j = i + delta;
  if (i < 0 || j < 0 || j >= pins.length) return pins;
  const next = pins.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function buildQueue(state, groupBy, pins = [], collapsed = new Set()) {
  const answers = state.answers;
  const byId = Object.fromEntries(state.cards.map((c) => [c.id, c]));
  const st = (c) => state.states[c.id];
  const visible = state.cards;
  const levels = state.levels || [];
  const levelOf = (c) => (state.priorities || {})[c.id] || c.priority;
  const rank = (c) => { const i = levels.findIndex((l) => l.id === levelOf(c)); return i < 0 ? levels.length : i; };
  const label = (id) => (levels.find((l) => l.id === id) || {}).label || id;
  const waiting = (s) => ['open', 'orphaned', 'held'].includes(s);
  // A card triage still checks has no verdict yet: it does not wait for the person, so the queue leaves it out.
  const pending = visible.filter((c) => waiting(st(c)))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  const tagOf = (c, key) => String((c.tags || {})[key] || '').trim();
  // The inbox's own cards come first, above every pinned group and every Group by choice, so an approval never waits
  // behind a pin. A system card keeps out of the groups, even when it carries the tag a pin matches.
  const systems = pending.filter((c) => c.kind === 'system');
  const others = pending.filter((c) => c.kind !== 'system');
  // Each pin is a group below them, and a card that matches two pins goes to the oldest one. A tag pin matches the tag
  // it names, and an agent pin the agent that posted the card. Its heading names the tag and value, or the agent as the
  // person knows it: the name its session reports, else the one on its newest card, else its id.
  const pinMatches = (pin, c) => (Array.isArray(pin) ? tagOf(c, pin[0]) === pin[1] : c.agent === pin?.agent);
  const pinOf = (c) => pins.findIndex((pin) => pinMatches(pin, c));
  const pinned = pins.map((pin, i) => ({
    pin,
    title: Array.isArray(pin) ? `${pin[0]}: ${pin[1]}` : agentName(pin?.agent ?? '', visible, state.presence),
    id: Array.isArray(pin) ? groupId('pin', pin[0], pin[1]) : groupId('agent-pin', pin?.agent ?? ''),
    items: others.filter((c) => pinOf(c) === i),
  }));
  const unpinned = others.filter((c) => pinOf(c) < 0);
  const sentAt = (c) => (c.closed ? c.closed.at : answers[c.id] ? answers[c.id].savedAt : 0);
  const outbox = visible.filter((c) => ['answered', 'delivered'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const sent = visible.filter((c) => ['read', 'closed'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  // No grouping by default. The choices follow the properties the cards carry.
  const tagKeys = [...new Set(visible.flatMap((c) => Object.keys(c.tags || {})))].sort();
  const tagKey = groupBy.startsWith('tag:') ? groupBy.slice(4) : null;
  const groupKey = (c) => (groupBy === 'priority' ? label(levelOf(c)) : groupBy === 'agent' ? agentName(c.agent, visible, state.presence) : tagKey !== null ? tagOf(c, tagKey) || `No ${tagKey}` : 'Waiting for you');
  // The cards the inbox clears: answered or closed. Search still finds them.
  const dealt = visible.filter((c) => ['closed', 'answered', 'delivered', 'read'].includes(st(c)));
  const grouped = groupBy === 'none' ? [['Waiting for you', unpinned]] : [...unpinned.reduce((m, c) => m.set(groupKey(c), [...(m.get(groupKey(c)) || []), c]), new Map())];
  // A group is named by its kind and its value, so another Group by choice has its own collapsed groups and switching
  // back restores them. Under a tag grouping, a group of one value names its tag, so its heading can pin it. A group of
  // cards with no value has no value part, so it can't share the id of a group whose value reads `(none)`.
  const groups = grouped.map(([title, items]) => {
    const value = tagKey !== null ? tagOf(items[0], tagKey) : '';
    const tag = tagKey !== null && value ? [tagKey, value] : undefined;
    const id = tagKey !== null ? groupId('tag', tagKey, ...(value ? [value] : [])) : groupBy === 'priority' ? groupId('priority', label(levelOf(items[0]))) : groupId(groupBy, title);
    return [title, items, tag, id];
  });
  // The group each card sits in, so a card that arrives knows whether its group is collapsed, and the terminal
  // client's key can collapse the group of the card on screen.
  const groupOf = {};
  for (const c of systems) groupOf[c.id] = SECTION_ID.system;
  for (const p of pinned) for (const c of p.items) groupOf[c.id] = p.id;
  for (const [, items, , id] of groups) for (const c of items) groupOf[c.id] = id;
  for (const c of outbox) groupOf[c.id] = SECTION_ID.outbox;
  for (const c of sent) groupOf[c.id] = SECTION_ID.sent;
  // A collapsed group keeps its heading and its cards, for the count, but its cards leave the queue order: Skip for
  // now and the card after an answer pass over them, while a card opened by a link still opens.
  const hidden = new Set(Object.keys(groupOf).filter((id) => collapsed.has(groupOf[id])));
  const order = [
    ...(collapsed.has(SECTION_ID.system) ? [] : systems),
    ...pinned.flatMap((p) => (collapsed.has(p.id) ? [] : p.items)),
    ...groups.flatMap(([, items, , id]) => (collapsed.has(id) ? [] : items)),
  ];
  return { byId, st, levelOf, label, waiting, pending, systems, pinned, outbox, sent, tagKeys, dealt, groups, groupOf, hidden, order };
}

/** Whether a card that just arrived raises a notification. A card in a collapsed group raises none, unless it is at the highest
 * level: muting a group must never hide an urgent card. The page decides this for the Notification API, and the inbox for
 * each device it pushes to, so both follow one rule. `groupBy` and `pins` default to the inbox's settings. */
export function notifies(state, card, collapsed = new Set(), groupBy = (state.settings || {}).groupBy || 'none', pins = (state.settings || {}).pins || []) {
  if (!collapsed.size) return true;
  const q = buildQueue(state, groupBy, pins, collapsed);
  const top = (state.levels || [])[0];
  return !q.hidden.has(card.id) || (!!top && q.levelOf(card) === top.id);
}

/** The card after `id` in queue order, wrapping around at the end. */
export function after(order, id) {
  const i = order.findIndex((c) => c.id === id);
  const rest = i < 0 ? order : [...order.slice(i + 1), ...order.slice(0, i)];
  return (rest[0] || {}).id || null;
}
