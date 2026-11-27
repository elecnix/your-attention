// Call one route of an in-memory inbox through its HTTP handler, with a new token of one role. The token is never the
// one that posted a card in the test, so a route that checks the poster refuses it.
import { createHandler } from '../../src/core/http.ts';
import type { Inbox } from '../../src/core/inbox.ts';

export async function call(inbox: Inbox, role: 'owner' | 'agent' | 'extension', method: string, route: string, body?: unknown): Promise<Response> {
  const { secret } = await inbox.createToken(role, role);
  return createHandler(inbox)(new Request(`http://inbox.test${route}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
}
