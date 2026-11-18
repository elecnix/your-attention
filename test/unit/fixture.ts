// A stand-in inbox, its callers and the events one agent's stream receives, for the tests that post, send and answer.
import { createHandler } from '../../src/core/http.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent, Answer, Card } from '../../src/core/types.ts';

export const agent: Caller = { token: 'ta', role: 'agent' };
export const owner: Caller = { token: 'to', role: 'owner' };

/** The moment a clocked inbox starts at, which a test that reads a card's times counts from. */
export const NOW = 1_800_000_000_000;

/** An inbox in memory whose clock a test moves, with the events one agent's connection receives. */
export function setup() {
  let now = NOW;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const inbox = new Inbox(new MemoryStorage(), clock.now, new MemoryBlobs());
  const events: AgentEvent[] = [];
  return { inbox, agent, owner, clock, events, connect: (id: string) => { inbox.connect(agent, id, (ev) => events.push(ev)); } };
}

/** The cards among the events a stream received. */
export const cardEvents = (events: AgentEvent[]): Extract<AgentEvent, { type: 'card' }>[] => events.filter((e): e is Extract<AgentEvent, { type: 'card' }> => e.type === 'card');

/** An inbox in memory, holding one card from `s1` titled "Which one?". */
export function oneCardInbox(): Inbox {
  const inbox = new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs());
  inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
  return inbox;
}

/** An answer to card c1: the values and comment a test reads back. */
export const answered = (values: Record<string, unknown> = {}, comment = ''): Answer => ({ card: 'c1', version: 1, values, comment, delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [] });

/** An inbox behind the HTTP handler, with the tokens of a page, two agents and an extension, and the call function that
 * sends one of them with each request. */
export async function httpInbox(inbox: Inbox = new Inbox(new MemoryStorage(), () => 1_000)) {
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const owner = (await inbox.createToken('page', 'owner')).secret;
  const agentA = (await inbox.createToken('agent a', 'agent')).secret;
  const agentB = (await inbox.createToken('agent b', 'agent')).secret;
  const ext = (await inbox.createToken('triage extension', 'extension')).secret;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> =>
    handle(new Request(`http://inbox.test${path}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }));
  /** Post a card from agent `s1` unless the body names another, and read back the card the inbox stored. */
  const post = async (token: string, body: Record<string, unknown>): Promise<Card> =>
    (await (await call('POST', '/v1/cards', { token, body: { agent: 's1', ...body } })).json()) as Card;
  return { inbox, handle, call, post, owner, agentA, agentB, ext };
}
