import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COOKIE, createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { PIN_TRIES, UNLOCK_HEADER } from '../../src/core/pin.ts';
import { MemoryStorage } from '../../src/core/storage.ts';

async function setup() {
  const inbox = new Inbox(new MemoryStorage(), Date.now, undefined, { pinIterations: 1000 });
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  // A token that can travel as a link or a cookie, such as a sign-in code's, and the laptop's own file token.
  const link = (await inbox.createToken('device', 'owner')).secret;
  const local = (await inbox.createToken('page', 'owner', { pinExempt: true })).secret;
  const agent = (await inbox.createToken('agents', 'agent')).secret;
  const call = (method: string, path: string, opts: { token?: string; cookie?: string; unlock?: string; body?: unknown } = {}) =>
    handle(new Request(`http://inbox.test${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.cookie ? { cookie: `${COOKIE}=${encodeURIComponent(opts.cookie)}`, 'x-your-attention': '1' } : {}),
        ...(opts.unlock ? { [UNLOCK_HEADER]: opts.unlock } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }));
  const unlock = async (pin: string, as: { token?: string; cookie?: string }) => {
    const res = await call('POST', '/v1/unlock', { ...as, body: { pin } });
    return { status: res.status, body: (await res.json()) as { unlock?: string; triesLeft?: number; lockedUntil?: number; error?: string }, headers: res.headers };
  };
  return { inbox, call, link, local, agent, unlock };
}

describe('the PIN gate', () => {
  it('lets every owner in while the inbox has no PIN, and reports the prompt', async () => {
    const { call, link } = await setup();
    assert.equal((await call('GET', '/v1/state', { cookie: link })).status, 200);
    const s = (await (await call('GET', '/v1/pin', { cookie: link })).json()) as Record<string, unknown>;
    assert.deepEqual(s, { set: false, neverAsk: false, unlocked: true, lockedUntil: null, triesLeft: PIN_TRIES, exempt: false });
  });

  it('stores "never ask" for the inbox', async () => {
    const { call, link, inbox } = await setup();
    assert.equal((await call('PUT', '/v1/pin/never-ask', { cookie: link, body: { neverAsk: true } })).status, 200);
    assert.equal(inbox.pin.status().neverAsk, true);
    assert.equal((await call('PUT', '/v1/pin/never-ask', { cookie: link, body: { neverAsk: 'yes' } })).status, 400);
  });

  it('locks the page and link tokens once a PIN is set, and leaves the laptop file token and agents alone', async () => {
    const { call, link, local, agent } = await setup();
    const set = await call('PUT', '/v1/pin', { cookie: link, body: { pin: '2468' } });
    assert.equal(set.status, 200);
    const { unlock } = (await set.json()) as { unlock: string };
    assert.ok(unlock, 'the tab that set the PIN stays unlocked');
    assert.equal((await call('GET', '/v1/state', { cookie: link })).status, 423);
    assert.equal((await call('GET', '/v1/state', { token: link })).status, 423, 'a link token used as a bearer token needs the PIN too');
    assert.equal((await call('GET', '/v1/state', { cookie: local })).status, 423, 'every cookie needs the PIN');
    assert.equal((await call('GET', '/v1/state', { token: local })).status, 200);
    assert.equal((await call('GET', '/v1/state', { cookie: link, unlock })).status, 200);
    assert.equal((await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's', title: 'q' } })).status, 201);
    assert.equal((await call('POST', '/v1/cards/c1/answer', { cookie: link, body: {} })).status, 423);
    assert.equal((await call('POST', '/v1/cards/c1/answer', { cookie: link, unlock, body: {} })).status, 200);
  });

  it('keeps an unlock token to the owner token that unlocked', async () => {
    const { call, link, inbox } = await setup();
    await inbox.pin.set('2468');
    const other = (await inbox.createToken('phone', 'owner')).secret;
    const { unlock } = (await (await call('POST', '/v1/unlock', { cookie: link, body: { pin: '2468' } })).json()) as { unlock: string };
    assert.equal((await call('GET', '/v1/state', { cookie: other, unlock })).status, 423);
  });

  it('counts wrong tries, then says how long to wait, and the laptop can still reset', async () => {
    const { call, link, local, unlock, inbox } = await setup();
    await inbox.pin.set('2468');
    for (let i = 1; i < PIN_TRIES; i++) {
      const r = await unlock('1111', { cookie: link });
      assert.equal(r.status, 401);
      assert.equal(r.body.triesLeft, PIN_TRIES - i);
    }
    const locked = await unlock('1111', { cookie: link });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 59);
    assert.ok(locked.body.lockedUntil);
    assert.equal((await unlock('2468', { cookie: link })).status, 429, 'the right PIN waits too');
    // The laptop's owner-token file resets the PIN without the old one, lockout or not.
    assert.equal((await call('PUT', '/v1/pin', { token: local, body: { pin: '1357' } })).status, 200);
    assert.equal((await unlock('1357', { cookie: link })).status, 200);
  });

  it('needs the current PIN to change or remove it from the page', async () => {
    const { call, link, inbox } = await setup();
    await inbox.pin.set('2468');
    const { unlock } = (await (await call('POST', '/v1/unlock', { cookie: link, body: { pin: '2468' } })).json()) as { unlock: string };
    assert.equal((await call('PUT', '/v1/pin', { cookie: link, unlock, body: { pin: '1357' } })).status, 403);
    assert.equal((await call('PUT', '/v1/pin', { cookie: link, unlock, body: { pin: '1357', current: '0000' } })).status, 401);
    const changed = await call('PUT', '/v1/pin', { cookie: link, unlock, body: { pin: '1357', current: '2468' } });
    assert.equal(changed.status, 200);
    assert.equal((await call('GET', '/v1/state', { cookie: link, unlock })).status, 423, 'a new PIN ends every unlocked tab');
    const fresh = ((await changed.json()) as { unlock: string }).unlock;
    assert.equal((await call('GET', '/v1/state', { cookie: link, unlock: fresh })).status, 200);
    assert.equal((await call('DELETE', '/v1/pin', { cookie: link, unlock: fresh, body: {} })).status, 403);
    assert.equal((await call('DELETE', '/v1/pin', { cookie: link, unlock: fresh, body: { current: '1357' } })).status, 200);
    assert.equal(inbox.pin.isSet(), false);
    assert.equal((await call('GET', '/v1/state', { cookie: link })).status, 200);
  });

  it('refuses a PIN that is not 4 digits', async () => {
    const { call, link } = await setup();
    assert.equal((await call('PUT', '/v1/pin', { cookie: link, body: { pin: '12345' } })).status, 400);
    assert.equal((await call('PUT', '/v1/pin', { cookie: link, body: { pin: 1234 } })).status, 400);
  });

  it('ends a tab\'s unlock on lock, and every unlock of a revoked token', async () => {
    const { call, link, local, inbox } = await setup();
    await inbox.pin.set('2468');
    const one = ((await (await call('POST', '/v1/unlock', { cookie: link, body: { pin: '2468' } })).json()) as { unlock: string }).unlock;
    assert.equal((await call('POST', '/v1/lock', { cookie: link, unlock: one, body: {} })).status, 200);
    assert.equal((await call('GET', '/v1/state', { cookie: link, unlock: one })).status, 423);
    const two = ((await (await call('POST', '/v1/unlock', { cookie: link, body: { pin: '2468' } })).json()) as { unlock: string }).unlock;
    const id = link.split('.')[0] ?? '';
    assert.equal((await call('DELETE', `/v1/tokens/${id}`, { token: local })).status, 200);
    assert.equal(await inbox.pin.verifyUnlock(two, id), undefined);
  });

  it('keeps agents and extensions out of the PIN routes', async () => {
    const { call, agent } = await setup();
    for (const [m, p] of [['GET', '/v1/pin'], ['PUT', '/v1/pin'], ['POST', '/v1/unlock'], ['PUT', '/v1/pin/never-ask']] as const) {
      assert.equal((await call(m, p, { token: agent, body: m === 'GET' ? undefined : { pin: '1234' } })).status, 403, `${m} ${p}`);
    }
  });

  it('serves attachments to a locked cookie, since only an unlocked page can list their ids', async () => {
    const { call, link, agent, inbox } = await setup();
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const card = (await (await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's', title: 'q', attachments: [{ src: png, name: 'a.png' }] } })).json()) as { attachments: { id: string }[] };
    await inbox.pin.set('2468');
    assert.equal((await call('GET', `/v1/attachments/${card.attachments[0]?.id}`, { cookie: link })).status, 200);
  });

  it('never replays a PIN response from the message memory', async () => {
    const { handle, link, inbox } = await (async () => { const s = await setup(); return { ...s, handle: createHandler(s.inbox) }; })();
    await inbox.pin.set('2468');
    const send = (pin: string) => handle(new Request('http://inbox.test/v1/unlock', { method: 'POST', headers: { authorization: `Bearer ${link}`, 'x-message-id': 'abcdefgh-1' }, body: JSON.stringify({ pin }) }));
    assert.equal((await send('2468')).status, 200);
    const again = await send('0000');
    assert.equal(again.status, 401);
    assert.equal(again.headers.get('x-message-id-replayed'), null);
  });

  it('closes the page event stream when its unlock ends', async () => {
    const { call, link, inbox } = await setup();
    await inbox.pin.set('2468');
    assert.equal((await call('GET', '/v1/events', { cookie: link })).status, 423);
    const { unlock } = (await (await call('POST', '/v1/unlock', { cookie: link, body: { pin: '2468' } })).json()) as { unlock: string };
    const res = await call('GET', `/v1/events?unlock=${encodeURIComponent(unlock)}`, { cookie: link });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read();
    await inbox.pin.set('1357');
    const end = await Promise.race([(async () => { for (;;) { const r = await reader.read(); if (r.done) return 'closed'; } })(), new Promise((r) => setTimeout(() => r('open'), 1000))]);
    assert.equal(end, 'closed');
  });
});
