// The queue, built from the card summaries of GET /v1/state: each card's state, its priority level, the sections of the list, and the order Skip for now and Send
// answer move through. The page and the terminal client share this file, so both show the same queue.

export const CLOSED_LABEL = { retracted: 'Retracted by agent', 'self-answered': 'Answered by agent', 'answered-in-terminal': 'Answered in the terminal', resolved: 'No longer waiting', expired: 'Expired', returned: 'Sent back to its agent' };
export const STATE_LABEL = { open: 'to answer', 'in-triage': 'being checked by triage', held: 'held by an extension', orphaned: 'its agent is gone', answered: 'stored', delivered: 'delivered', read: 'read', closed: 'closed', reply: 'new reply' };

const lastReply = (c) => c.replyAt || 0;

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
  const unread = state.cards.some((c) => c.agent === card.agent && state.states[c.id] === 'delivered');
  return unread ? ['busy', 'Agent busy: it has an answer it has not read yet'] : ['on', 'Agent listening'];
}

/** The queue for GET /v1/state, grouped by nothing, priority, agent or tag:<key>. */
export function buildQueue(state, groupBy) {
  const answers = state.answers;
  const byId = Object.fromEntries(state.cards.map((c) => [c.id, c]));
  // A reply newer than your answer brings the card back to your queue.
  const st = (c) => {
    const s = state.states[c.id];
    if (c.unseenReplies && (!answers[c.id] || lastReply(c) > answers[c.id].savedAt)) return 'reply';
    return s;
  };
  const visible = state.cards;
  const levels = state.levels || [];
  const levelOf = (c) => (state.priorities || {})[c.id] || c.priority;
  const rank = (c) => { const i = levels.findIndex((l) => l.id === levelOf(c)); return i < 0 ? levels.length : i; };
  const label = (id) => (levels.find((l) => l.id === id) || {}).label || id;
  const waiting = (s) => ['open', 'reply', 'orphaned', 'held'].includes(s);
  const pending = visible.filter((c) => waiting(st(c)))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  const checking = visible.filter((c) => st(c) === 'in-triage');
  const replied = pending.filter((c) => st(c) === 'reply').sort((a, b) => lastReply(b) - lastReply(a));
  const sentAt = (c) => (c.closed ? c.closed.at : answers[c.id] ? answers[c.id].savedAt : 0);
  const outbox = visible.filter((c) => ['answered', 'delivered'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  const sent = visible.filter((c) => ['read', 'closed'].includes(st(c))).sort((a, b) => sentAt(b) - sentAt(a));
  // No grouping by default. The choices follow the properties the cards carry.
  const tagKeys = [...new Set(visible.flatMap((c) => Object.keys(c.tags || {})))].sort();
  const groupKey = (c) => (groupBy === 'priority' ? label(levelOf(c)) : groupBy === 'agent' ? agentName(c.agent, visible) : groupBy.startsWith('tag:') ? String((c.tags || {})[groupBy.slice(4)] || '').trim() || `No ${groupBy.slice(4)}` : 'Waiting for you');
  const rest = pending.filter((c) => st(c) !== 'reply');
  // The cards the inbox clears: answered or closed, with no agent reply you have not seen. Search still finds them.
  const dealt = visible.filter((c) => ['closed', 'answered', 'delivered', 'read'].includes(st(c)));
  const groups = groupBy === 'none' ? [['Waiting for you', rest]] : [...rest.reduce((m, c) => m.set(groupKey(c), [...(m.get(groupKey(c)) || []), c]), new Map())];
  const order = [...replied, ...groups.flatMap(([, items]) => items)];
  return { byId, st, levelOf, label, waiting, pending, checking, replied, outbox, sent, tagKeys, dealt, groups, order };
}

/** The card after `id` in queue order, wrapping around at the end. */
export function after(order, id) {
  const i = order.findIndex((c) => c.id === id);
  const rest = i < 0 ? order : [...order.slice(i + 1), ...order.slice(0, i)];
  return (rest[0] || {}).id || null;
}
