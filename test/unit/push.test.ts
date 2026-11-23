// Web Push in the inbox: the subscription routes, the VAPID key, and a push for each new card that would notify today.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, InboxError } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { b64urlEncode, decryptPayload } from '../../src/core/webpush.ts';
import { notifies } from '../../web/queue.js';

interface Device { endpoint: string; keys: { p256dh: string; auth: string }; privateKey: string }

/** A subscriber as a browser makes one: its own key pair and secret, and an address at its push service. */
async function device(name: string): Promise<Device> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    endpoint: `https://push.example.invalid/send/${name}`,
    keys: { p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    privateKey: String(jwk.d),
  };
}

interface Sent { url: string; headers: Headers; body: Uint8Array<ArrayBuffer> }

function setup(status: (url: string, n: number) => number | Promise<number> = () => 201) {
  let t = 1_800_000_000_000;
  const sent: Sent[] = [];
  const calls = new Map<string, number>();
  const fetcher = (async (url: string, init: RequestInit) => {
    const n = (calls.get(url) ?? 0) + 1;
    calls.set(url, n);
    sent.push({ url, headers: new Headers(init.headers), body: new Uint8Array(init.body as Uint8Array) });
    return new Response(null, { status: await status(url, n) });
  }) as unknown as typeof fetch;
  const store = new MemoryStorage();
  const inbox = new Inbox(store, () => t, undefined, { fetch: fetcher, pushRule: (s, c, collapsed) => notifies(s, c, collapsed), pushWait: async () => {} });
  const settle = async (): Promise<void> => { while (inbox.deliveries.size) await Promise.all([...inbox.deliveries]); };
  const owner = { token: 'to', role: 'owner' as const };
  const agent = { token: 'ta', role: 'agent' as const };
  const read = async (s: Sent, d: Device) => JSON.parse(new TextDecoder().decode(await decryptPayload(s.body, { publicKey: d.keys.p256dh, privateKey: d.privateKey, auth: d.keys.auth }))) as Record<string, unknown>;
  return { inbox, store, sent, calls, settle, owner, agent, read, clock: { advance: (ms: number) => { t += ms; } } };
}

const rejects = (status: number, message: RegExp) => (e: unknown): boolean => e instanceof InboxError && e.status === status && message.test(e.message);

describe('push subscriptions', () => {
  it('saves one subscription per endpoint and deletes it by endpoint', async () => {
    const { inbox, owner } = setup();
    const a = await device('a');
    inbox.savePush(owner, { ...a });
    inbox.savePush(owner, { ...a, collapsed: ['tag: topic: billing'] });
    assert.equal(inbox.pushCount(), 1, 'the same endpoint is one device');
    inbox.savePush(owner, { ...(await device('b')) });
    assert.equal(inbox.pushCount(), 2);
    inbox.deletePush(a.endpoint);
    assert.equal(inbox.pushCount(), 1);
    inbox.deletePush(a.endpoint);
    assert.equal(inbox.pushCount(), 1, 'deleting a subscription that is gone is not an error');
  });

  it('refuses what is not a push subscription', async () => {
    const { inbox, owner } = setup();
    const a = await device('a');
    assert.throws(() => inbox.savePush(owner, { ...a, endpoint: 'http://push.example.invalid/x' }), rejects(400, /https/));
    assert.throws(() => inbox.savePush(owner, { ...a, endpoint: 'not a url' }), rejects(400, /endpoint/));
    assert.throws(() => inbox.savePush(owner, { ...a, endpoint: `https://push.example.invalid/${'x'.repeat(3000)}` }), rejects(400, /endpoint/));
    assert.throws(() => inbox.savePush(owner, { ...a, keys: { ...a.keys, p256dh: 'AAAA' } }), rejects(400, /p256dh/));
    assert.throws(() => inbox.savePush(owner, { ...a, keys: { ...a.keys, auth: 'AAAA' } }), rejects(400, /auth/));
    assert.throws(() => inbox.savePush(owner, { ...a, collapsed: 'nope' as unknown as string[] }), rejects(400, /collapsed/));
    assert.equal(inbox.pushCount(), 0);
  });

  it('answers 400, not a crash, for a key that is not valid base64url', async () => {
    const { inbox, owner } = setup();
    const a = await device('a');
    assert.throws(() => inbox.savePush(owner, { ...a, keys: { ...a.keys, p256dh: 'A' } }), rejects(400, /p256dh/));
    assert.throws(() => inbox.savePush(owner, { ...a, keys: { ...a.keys, auth: 'A' } }), rejects(400, /auth/));
  });

  it('keeps at most 20 devices', async () => {
    const { inbox, owner } = setup();
    for (let i = 0; i < 20; i++) inbox.savePush(owner, { ...(await device(`d${i}`)) });
    const extra = await device('one-more');
    assert.throws(() => inbox.savePush(owner, extra), rejects(400, /20/));
    // A device that is already saved can still change.
    inbox.savePush(owner, { ...(await device('d0')), collapsed: [] });
  });

  it('removes a device when its token is revoked, so a signed-out phone stops getting titles', async () => {
    const { inbox } = setup();
    const t = await inbox.createToken('phone', 'owner');
    inbox.savePush({ token: t.token.id, role: 'owner' }, { ...(await device('phone')) });
    inbox.savePush({ token: 'other', role: 'owner' }, { ...(await device('laptop')) });
    inbox.revokeToken(t.token.id);
    assert.equal(inbox.pushCount(), 1);
  });
});

describe('the VAPID key', () => {
  it('is made once, kept with the inbox, and the same after a restart', async () => {
    const store = new MemoryStorage();
    const a = new Inbox(store);
    const key = await a.pushKey();
    assert.match(key, /^[\w-]{87}$/, '65 bytes, base64url');
    assert.equal(await a.pushKey(), key);
    const b = new Inbox(store);
    assert.equal(await b.pushKey(), key, 'a new object on the same storage keeps the key');
    assert.notEqual(await new Inbox(new MemoryStorage()).pushKey(), key, 'each inbox has its own');
  });

  it('is made once even when two Inbox objects over the same storage ask at the same moment', async () => {
    const store = new MemoryStorage();
    const [a, b] = await Promise.all([new Inbox(store).pushKey(), new Inbox(store).pushKey()]);
    assert.equal(a, b, 'the second to finish uses the key the first stored');
    assert.equal(await new Inbox(store).pushKey(), a);
  });

  it('is made once even when two requests ask at the same moment', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const [a, b] = await Promise.all([inbox.pushKey(), inbox.pushKey()]);
    assert.equal(a, b);
  });
});

describe('a push for each new card', () => {
  it('sends one encrypted push to every saved device, with the card title and id only', async () => {
    const { inbox, owner, agent, sent, settle, read } = setup();
    const [a, b] = [await device('a'), await device('b')];
    inbox.savePush(owner, a);
    inbox.savePush(owner, b);
    const card = inbox.postCard(agent, { agent: 's1', title: 'Which branch?', text: 'a long secret-looking text', recommendation: 'main' });
    await settle();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((s) => s.url).sort(), [a.endpoint, b.endpoint]);
    for (const [s, d] of [[sent.find((x) => x.url === a.endpoint)!, a], [sent.find((x) => x.url === b.endpoint)!, b]] as const) {
      assert.deepEqual(await read(s, d), { id: card.id, title: 'Which branch?' });
      assert.equal(s.headers.get('content-encoding'), 'aes128gcm');
      assert.match(s.headers.get('authorization') ?? '', new RegExp(`^vapid t=.+, k=${await inbox.pushKey()}$`));
      const text = new TextDecoder('latin1').decode(s.body);
      assert.ok(!text.includes('Which branch?') && !text.includes('secret-looking'), 'the push service reads nothing');
    }
  });

  it('sends nothing when no device is saved, or for a revision of a card', async () => {
    const { inbox, owner, agent, sent, settle } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'First' });
    await settle();
    assert.equal(sent.length, 0);
    inbox.savePush(owner, await device('a'));
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'First, revised' }, undefined, undefined, undefined, { revise: true });
    await settle();
    assert.equal(sent.length, 0, 'a revision is not a new card');
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Second' });
    await settle();
    assert.equal(sent.length, 1);
  });

  it('cuts a long title, so the message fits one record', async () => {
    const { inbox, owner, agent, sent, settle, read } = setup();
    const a = await device('a');
    inbox.savePush(owner, a);
    inbox.postCard(agent, { agent: 's1', title: 'é'.repeat(200) });
    await settle();
    const { title } = (await read(sent[0]!, a)) as { title: string };
    assert.ok(title.length <= 120 && title.endsWith('…'));
  });

  it('answers the post at once, without waiting for a slow push service', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { inbox, owner, agent, sent, settle } = setup(async () => { await gate; return 201; });
    inbox.savePush(owner, await device('slow'));
    const card = inbox.postCard(agent, { agent: 's1', title: 'Now' });
    assert.equal(card.title, 'Now', 'the card is stored and returned');
    assert.equal(inbox.getCard(card.id).title, 'Now');
    assert.equal(inbox.deliveries.size, 1, 'the push runs on, where the platform can wait for it');
    release();
    await settle();
    assert.equal(sent.length, 1);
  });

  it('never fails a card because a push failed', async () => {
    const fetcher = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
    const inbox = new Inbox(new MemoryStorage(), Date.now, undefined, { fetch: fetcher, pushWait: async () => {} });
    inbox.savePush({ token: 'to', role: 'owner' }, await device('a'));
    const card = inbox.postCard({ token: 'ta', role: 'agent' }, { agent: 's1', title: 'Still here' });
    await Promise.all([...inbox.deliveries]);
    assert.equal(inbox.getCard(card.id).title, 'Still here');
    assert.equal(inbox.pushCount(), 1, 'a network error does not drop the device');
  });

  it('tries a failing push service three times at most, and keeps the device', async () => {
    const { inbox, owner, agent, calls, settle } = setup(() => 503);
    const a = await device('a');
    inbox.savePush(owner, a);
    inbox.postCard(agent, { agent: 's1', title: 'Retry' });
    await settle();
    assert.equal(calls.get(a.endpoint), 3);
    assert.equal(inbox.pushCount(), 1);
  });

  it('forgets a device the push service answers 404 or 410 for, and still pushes the others', async () => {
    const [a, b, c] = [await device('gone-404'), await device('gone-410'), await device('fine')];
    const { inbox, owner, agent, calls, settle } = setup((url) => (url === a.endpoint ? 404 : url === b.endpoint ? 410 : 201));
    for (const d of [a, b, c]) inbox.savePush(owner, d);
    inbox.postCard(agent, { agent: 's1', title: 'Cleanup' });
    await settle();
    assert.equal(inbox.pushCount(), 1);
    assert.equal(calls.get(a.endpoint), 1, 'gone is not retried');
    assert.equal(calls.get(c.endpoint), 1);
    inbox.postCard(agent, { agent: 's1', title: 'Again' });
    await settle();
    assert.equal(calls.get(a.endpoint), 1, 'a forgotten device gets no more pushes');
    assert.equal(calls.get(c.endpoint), 2);
  });
});

describe('which cards push, the rules the open page follows', () => {
  const pin = (inbox: Inbox): void => { inbox.setSettings({ groupBy: 'tag:topic' }); };

  it('skips a card in a group this device collapsed, and pushes the same card to a device that did not', async () => {
    const { inbox, owner, agent, sent, settle } = setup();
    pin(inbox);
    const [quiet, loud] = [await device('quiet'), await device('loud')];
    inbox.savePush(owner, { ...quiet, collapsed: ['tag: topic: billing'] });
    inbox.savePush(owner, loud);
    inbox.postCard(agent, { agent: 's1', title: 'Invoice?', tags: { topic: 'billing' } });
    inbox.postCard(agent, { agent: 's1', title: 'Search?', tags: { topic: 'search' } });
    await settle();
    const to = (d: Device) => sent.filter((s) => s.url === d.endpoint).length;
    assert.equal(to(quiet), 1, 'only the search card');
    assert.equal(to(loud), 2);
  });

  it('pushes a card at the highest level even in a collapsed group, so muting never hides an urgent card', async () => {
    const { inbox, owner, agent, sent, settle, read } = setup();
    pin(inbox);
    const quiet = await device('quiet');
    inbox.savePush(owner, { ...quiet, collapsed: ['tag: topic: billing'] });
    inbox.postCard(agent, { agent: 's1', title: 'Soon', priority: 'soon', tags: { topic: 'billing' } });
    inbox.postCard(agent, { agent: 's1', title: 'Right now', priority: 'now', tags: { topic: 'billing' } });
    await settle();
    assert.equal(sent.length, 1);
    assert.equal((await read(sent[0]!, quiet))['title'], 'Right now');
  });

  it('applies the same rule on the page and on the server', () => {
    const state = {
      cards: [{ id: 'c', agent: 'a', kind: 'ask', title: 'T', priority: 'soon', tags: { topic: 'billing' }, createdAt: 1 }],
      answers: {}, presence: {}, states: { c: 'open' }, priorities: { c: 'soon' }, levels: [{ id: 'now', label: 'Now' }, { id: 'soon', label: 'Soon' }],
      settings: { groupBy: 'tag:topic', pins: [] },
    };
    const card = state.cards[0];
    assert.equal(notifies(state as never, card as never, new Set()), true);
    assert.equal(notifies(state as never, card as never, new Set(['tag: topic: billing'])), false);
    assert.equal(notifies(state as never, card as never, new Set(['tag: topic: search'])), true);
    // The page passes the Group by and pins it shows, which can be newer than the settings it fetched.
    assert.equal(notifies(state as never, card as never, new Set(['tag: topic: billing']), 'none', []), true);
  });

  it('pushes the inbox own cards, such as a pairing request, which are at the highest level even when their section is collapsed', async () => {
    const { inbox, owner, sent, settle } = setup();
    inbox.savePush(owner, { ...(await device('a')), collapsed: ['section: system'] });
    inbox.requestPairing('a new laptop', 'agent');
    await settle();
    assert.equal(sent.length, 1);
  });
});

describe('a push waits for triage, and goes once', () => {
  const ext = { token: 'tx', role: 'extension' as const };
  async function screened() {
    const t = setup();
    const calls: { id: string }[] = [];
    t.inbox.savePush(t.owner, await device('a'));
    t.inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'], timeoutMs: 5000 }, (e) => calls.push(e as { id: string }));
    return { ...t, calls };
  }

  it('sends nothing while a card.created hook screens the card, and sends once the hook passes it', async () => {
    const { inbox, agent, sent, settle, calls } = await screened();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Screened' });
    await settle();
    assert.equal(sent.length, 0);
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', '');
    await settle();
    assert.equal(sent.length, 1);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Screened, revised' }, undefined, undefined, undefined, { revise: true });
    await settle();
    assert.equal(sent.length, 1, 'one card, one push');
  });

  it('pushes once when the hook passes the card with advice, and keeps the advice on the card', async () => {
    const { inbox, agent, sent, settle, calls, store } = await screened();
    inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Screened with advice' });
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', '', 'Say which branch.');
    await settle();
    assert.equal(sent.length, 1);
    const stored = store.get<{ pushed?: boolean; pushback?: { kind: string; reason: string }[] }>('cards', 'c2')!;
    assert.equal(stored.pushed, true);
    assert.deepEqual(stored.pushback?.map((p) => [p.kind, p.reason]), [['advice', 'Say which branch.']]);
  });

  it('does not push a revision of a card stored before pushes existed, which has no mark', async () => {
    const { inbox, owner, agent, sent, settle, store } = setup();
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Before the deploy' });
    const stored = store.get<Record<string, unknown>>('cards', 'old')!;
    delete stored['pushed'];
    store.put('cards', 'old', stored);
    inbox.savePush(owner, await device('a'));
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Revised after the deploy' }, undefined, undefined, undefined, { revise: true });
    await settle();
    assert.equal(sent.length, 0, 'the person already had this card');
  });

  it('does not push a card stored before pushes existed when a hook that reconnects passes it', async () => {
    const { inbox, owner, agent, sent, settle, store, clock } = setup();
    // The extension has been connected before, which is what makes a reconnection screen the gap.
    inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'], timeoutMs: 5000 }, () => {})();
    clock.advance(60_000);
    inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Seen days ago' });
    const stored = store.get<Record<string, unknown>>('cards', 'old')!;
    delete stored['pushed'];
    store.put('cards', 'old', stored);
    inbox.savePush(owner, await device('a'));
    const calls: { id: string }[] = [];
    inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'], timeoutMs: 5000 }, (e) => calls.push(e as { id: string }));
    inbox.hookVerdict(ext, calls[0]!.id, 'pass', '');
    await settle();
    assert.equal(sent.length, 0, 'the person already had this card');
  });

  it('never pushes a card the hook sends back', async () => {
    const { inbox, agent, sent, settle, calls } = await screened();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Sent back' });
    inbox.hookVerdict(ext, calls[0]!.id, 'return', 'No recommendation.');
    await settle();
    assert.equal(sent.length, 0);
  });

  it('pushes a held card when the owner releases it', async () => {
    const { inbox, agent, sent, settle, calls } = await screened();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Held' });
    inbox.hookVerdict(ext, calls[0]!.id, 'hold', 'Check this one.');
    await settle();
    assert.equal(sent.length, 0);
    inbox.release('c1');
    await settle();
    assert.equal(sent.length, 1);
  });

  it('pushes a card that passes because the hook never answered', async () => {
    const { inbox, agent, sent, settle, clock } = await screened();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Slow hook' });
    clock.advance(6000);
    inbox.sweep();
    await settle();
    assert.equal(sent.length, 1);
  });

  it('keeps the flag that remembers a push out of what clients read', async () => {
    const { inbox, agent, settle } = setup();
    inbox.savePush({ token: 'to', role: 'owner' }, await device('a'));
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Plain' });
    await settle();
    assert.ok(!('pushed' in inbox.cardDetail('c1').card));
  });
});

describe('push routes', () => {
  async function http() {
    const t = setup();
    const handle = createHandler(t.inbox);
    const owner = (await t.inbox.createToken('page', 'owner')).secret;
    const agent = (await t.inbox.createToken('agent', 'agent')).secret;
    const call = (method: string, path: string, token: string | undefined, body?: unknown): Promise<Response> =>
      handle(new Request(`http://inbox.test${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { ...t, call, owner, agent };
  }

  it('GET /v1/push gives the owner the public key, and only that', async () => {
    const { call, owner, inbox } = await http();
    const res = await call('GET', '/v1/push', owner);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(Object.keys(JSON.parse(text)), ['publicKey']);
    assert.equal(JSON.parse(text).publicKey, await inbox.pushKey());
  });

  it('PUT saves and DELETE removes a subscription, for the owner only', async () => {
    const { call, owner, agent, inbox } = await http();
    const a = await device('a');
    assert.equal((await call('PUT', '/v1/push', undefined, a)).status, 401);
    assert.equal((await call('PUT', '/v1/push', agent, a)).status, 403, 'an agent token cannot subscribe a phone');
    assert.equal((await call('GET', '/v1/push', agent)).status, 403);
    const put = await call('PUT', '/v1/push', owner, { ...a, collapsed: ['section: system'] });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true });
    assert.equal(inbox.pushCount(), 1);
    assert.equal((await call('DELETE', '/v1/push', agent, { endpoint: a.endpoint })).status, 403);
    assert.equal((await call('DELETE', '/v1/push', owner, { endpoint: a.endpoint })).status, 200);
    assert.equal(inbox.pushCount(), 0);
  });

  it('takes a subscription with many long group ids, past the small-body limit', async () => {
    const { call, owner, inbox } = await http();
    const collapsed = Array.from({ length: 40 }, (_, i) => `tag: topic: ${'x'.repeat(250)}${i}`);
    const res = await call('PUT', '/v1/push', owner, { ...(await device('big')), collapsed });
    assert.equal(res.status, 200);
    assert.equal(inbox.pushCount(), 1);
  });

  it('answers a bad subscription with 400 and a reason', async () => {
    const { call, owner } = await http();
    const res = await call('PUT', '/v1/push', owner, { endpoint: 'http://x.invalid/', keys: {} });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /https/);
    assert.equal((await call('PUT', '/v1/push', owner, null)).status, 400);
    assert.equal((await call('DELETE', '/v1/push', owner, {})).status, 400);
  });

  it('never returns the private key in any route', async () => {
    const { call, owner, inbox } = await http();
    await inbox.pushKey();
    const vapid = (inbox as unknown as { store: MemoryStorage }).store.get<{ privateKey: { d: string } }>('meta', 'vapid');
    assert.ok(vapid?.privateKey.d);
    for (const path of ['/v1/push', '/v1/state', '/v1/info', '/v1/settings', '/v1/tokens']) {
      assert.ok(!(await (await call('GET', path, owner)).text()).includes(vapid.privateKey.d), path);
    }
  });
});
