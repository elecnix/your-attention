// The queue, built from the card summaries of GET /v1/state: each card's state, its priority level, the sections of the list, and the order Skip for now and Send
// answer move through. The page and the terminal client share this file, so both show the same queue.

export const CLOSED_LABEL = { retracted: 'Retracted by agent', 'self-answered': 'Answered by agent', 'answered-in-terminal': 'Answered in the terminal', resolved: 'No longer waiting', expired: 'Expired', returned: 'Sent back to its agent', dismissed: 'Dismissed' };
export const STATE_LABEL = { open: 'to answer', 'in-triage': 'being checked by triage', held: 'held by an extension', orphaned: 'its agent is gone', answered: 'stored', delivered: 'delivered', read: 'read', closed: 'closed' };
/** The ids of the sections that every Group by choice shows, so a collapsed one keeps its state across the choices. */
export const SECTION_ID = { checking: 'section: checking', outbox: 'section: outbox', sent: 'section: sent' };

// A group's id is its kind and value, such as tag: topic: billing. The ':' and '%' of a part are escaped, because an
// agent picks tag keys and values: without the escape, a tag named `section: outbox` would take the outbox's id.
const idPart = (s) => String(s).replace(/[%:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const groupId = (kind, ...parts) => [kind, ...parts.map(idPart)].join(': ');

// An agent's name for people: the session name its newest card carries, else its id.
export function agentName(id, cards) {
  let best = null;
  for (const c of cards) if (c.agent === id && c.origin && c.origin.name && (!best || c.createdAt > best.createdAt)) best = c;
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

/** The queue for GET /v1/state, grouped by nothing, priority, agent or tag:<key>. `pins` lists the pinned tag values as [key, value], oldest first. `collapsed` holds the ids of the groups the person muted, each the group's kind and value. */
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
  const pending = visible.filter((c) => waiting(st(c)))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  const checking = visible.filter((c) => st(c) === 'in-triage');
  const tagOf = (c, key) => String((c.tags || {})[key] || '').trim();
  // Each pinned value is a group at the top, and a card that matches two pins goes to the oldest one.
  const pinOf = (c) => pins.findIndex(([key, value]) => tagOf(c, key) === value);
  const pinned = pins.map(([key, value], i) => ({ key, value, id: groupId('pin', key, value), items: pending.filter((c) => pinOf(c) === i) }));
  const unpinned = pending.filter((c) => pinOf(c) < 0);
  const sentAt = (c) => (c.closed ? c.closed.at : answers[c.id] ? answers[c.id].savedAt : 0);
  const outbox = visible.filter((c) => ['answered', 'delivered'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const sent = visible.filter((c) => ['read', 'closed'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  // No grouping by default. The choices follow the properties the cards carry.
  const tagKeys = [...new Set(visible.flatMap((c) => Object.keys(c.tags || {})))].sort();
  const tagKey = groupBy.startsWith('tag:') ? groupBy.slice(4) : null;
  const groupKey = (c) => (groupBy === 'priority' ? label(levelOf(c)) : groupBy === 'agent' ? agentName(c.agent, visible) : tagKey !== null ? tagOf(c, tagKey) || `No ${tagKey}` : 'Waiting for you');
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
  for (const p of pinned) for (const c of p.items) groupOf[c.id] = p.id;
  for (const [, items, , id] of groups) for (const c of items) groupOf[c.id] = id;
  for (const c of checking) groupOf[c.id] = SECTION_ID.checking;
  for (const c of outbox) groupOf[c.id] = SECTION_ID.outbox;
  for (const c of sent) groupOf[c.id] = SECTION_ID.sent;
  // A collapsed group keeps its heading and its cards, for the count, but its cards leave the queue order: Skip for
  // now and the card after an answer pass over them, while a card opened by a link still opens.
  const hidden = new Set(Object.keys(groupOf).filter((id) => collapsed.has(groupOf[id])));
  const order = [
    ...pinned.flatMap((p) => (collapsed.has(p.id) ? [] : p.items)),
    ...groups.flatMap(([, items, , id]) => (collapsed.has(id) ? [] : items)),
  ];
  return { byId, st, levelOf, label, waiting, pending, checking, pinned, outbox, sent, tagKeys, dealt, groups, groupOf, hidden, order };
}

/** The card after `id` in queue order, wrapping around at the end. */
export function after(order, id) {
  const i = order.findIndex((c) => c.id === id);
  const rest = i < 0 ? order : [...order.slice(i + 1), ...order.slice(0, i)];
  return (rest[0] || {}).id || null;
}
