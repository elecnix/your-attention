import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COOKIE, createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';

async function setup() {
  const inbox = new Inbox(new MemoryStorage());
  const handle = createHandler(inbox, { heartbeatMs: 50 });
  const owner = (await inbox.createToken('page', 'owner')).secret;
  const agent = (await inbox.createToken('agents', 'agent')).secret;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    handle(new Request(`http://inbox.test${path}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }));
  return { inbox, call, owner, agent };
}

describe('http', () => {
  it('answers info without a token', async () => {
    const { call } = await setup();
    const res = await call('GET', '/v1/info');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { protocol: number }).protocol, 1);
  });

  it('refuses every other route without a token', async () => {
    const { call } = await setup();
    for (const [m, p] of [['GET', '/v1/state'], ['POST', '/v1/cards'], ['GET', '/v1/stream?agent=x'], ['GET', '/v1/search?q=x']] as const) {
      assert.equal((await call(m, p)).status, 401, `${m} ${p}`);
    }
  });

  it('keeps agents out of owner routes', async () => {
    const { call, agent } = await setup();
    assert.equal((await call('GET', '/v1/state', { token: agent })).status, 403);
    await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's1', title: 'q' } });
    assert.equal((await call('POST', '/v1/cards/c1/answer', { token: agent, body: {} })).status, 403);
  });

  it('posts, answers and acknowledges a card', async () => {
    const { call, agent, owner } = await setup();
    const posted = await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's1', title: 'q', options: [{ id: 'o1', label: 'Yes' }] } });
    assert.equal(posted.status, 201);
    assert.equal((await call('POST', '/v1/cards/c1/answer', { token: owner, body: { values: { choice: 'o1' } } })).status, 200);
    const acked = await call('POST', '/v1/cards/c1/ack', { token: agent, body: {} });
    assert.ok(((await acked.json()) as { readAt: number }).readAt);
  });

  it('never returns the id of the token that posted a card', async () => {
    const { call, agent } = await setup();
    const bodies = [
      await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's1', title: 'q' } }),
      await call('GET', '/v1/cards/c1', { token: agent }),
      await call('GET', '/v1/cards', { token: agent }),
      await call('POST', '/v1/cards/c1/reply', { token: agent, body: { text: 'more' } }),
      await call('POST', '/v1/cards/c1/claim', { token: agent, body: { agent: 's2' } }),
      await call('POST', '/v1/cards/c1/close', { token: agent, body: { kind: 'retracted', outcome: 'x' } }),
    ];
    for (const res of bodies) assert.doesNotMatch(await res.text(), /"token"/, res.url);
  });

  it('returns the error status from the inbox', async () => {
    const { call, agent } = await setup();
    assert.equal((await call('POST', '/v1/cards', { token: agent, body: { agent: 's1' } })).status, 400);
    assert.equal((await call('GET', '/v1/cards/missing', { token: agent })).status, 404);
  });

  it('signs a page in with a cookie, and requires the CSRF header on writes', async () => {
    const { call, owner, agent } = await setup();
    assert.equal((await call('POST', '/v1/login', { body: { token: agent } })).status, 401, 'an agent token cannot sign in a page');
    const login = await call('POST', '/v1/login', { body: { token: owner } });
    const setCookie = login.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    const cookie = `${COOKIE}=${encodeURIComponent(owner)}`;
    assert.equal((await call('GET', '/v1/state', { headers: { cookie } })).status, 200);
    await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's1', title: 'q' } });
    assert.equal((await call('POST', '/v1/cards/c1/answer', { headers: { cookie }, body: {} })).status, 403);
    assert.equal((await call('POST', '/v1/cards/c1/answer', { headers: { cookie, 'x-your-attention': '1' }, body: {} })).status, 200);
  });

  it('streams an answer to the agent as a server-sent event', async () => {
    const { call, agent, owner } = await setup();
    await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's1', title: 'q' } });
    const res = await call('GET', '/v1/stream?agent=s1', { token: agent });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    await call('POST', '/v1/cards/c1/answer', { token: owner, body: { comment: 'go' } });
    let text = '';
    while (!text.includes('event: answer')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"comment":"go"/);
    await reader.cancel();
  });

  it('runs the pairing flow over http', async () => {
    const { call, owner } = await setup();
    const res = await call('POST', '/v1/pair', { body: { name: 'ci runner' } });
    const { id, code } = (await res.json()) as { id: string; code: string };
    assert.match(code, /^\d{6}$/);
    await call('POST', `/v1/cards/pair-${id}/answer`, { token: owner, body: { values: { choice: 'approve' } } });
    const done = (await (await call('GET', `/v1/pair/${id}`)).json()) as { token: string };
    assert.equal((await call('GET', '/v1/dead-letters', { token: done.token })).status, 200);
  });
});

describe('http routes for the card model', () => {
  it('patches a card, labels it, and serves its image', async () => {
    const { call, agent } = await setup();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const posted = (await (await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's1', title: 'q', text: 'old', attachments: [{ src: png, alt: 'x' }] } })).json()) as { attachments: { id: string }[] };
    const patched = (await (await call('POST', '/v1/cards/c1/patch', { token: agent, body: { edits: [{ old: 'old', new: 'new' }] } })).json()) as { text: string };
    assert.equal(patched.text, 'new');
    assert.equal((await call('POST', '/v1/cards/c1/patch', { token: agent, body: { edits: [{ old: 'gone', new: 'x' }] } })).status, 409);
    assert.equal(((await (await call('POST', '/v1/cards/c1/status', { token: agent, body: { status: 'testing' } })).json()) as { status: string }).status, 'testing');
    const img = await call('GET', `/v1/attachments/${posted.attachments[0]!.id}`, { token: agent });
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.match(img.headers.get('content-security-policy') ?? '', /^sandbox/);
    assert.match(img.headers.get('content-disposition') ?? '', /^inline/);
  });

  it('serves a file type the page cannot render as a download, never as HTML', async () => {
    const { call, agent } = await setup();
    const html = `data:text/html;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
    const posted = (await (await call('POST', '/v1/cards', { token: agent, body: { id: 'c2', agent: 's1', title: 'q', attachments: [{ src: html, name: 'page.html' }] } })).json()) as { attachments: { id: string }[] };
    const res = await call('GET', `/v1/attachments/${posted.attachments[0]!.id}`, { token: agent });
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''page\.html/);
  });

  it('saves templates, changes priority levels, proposes guidance, and keeps settings for the owner', async () => {
    const { call, agent, owner } = await setup();
    assert.equal((await call('POST', '/v1/templates', { token: agent, body: { name: 't1', source: 'root = Card([])' } })).status, 201);
    assert.equal(((await (await call('GET', '/v1/templates/t1', { token: agent })).json()) as { versions: unknown[] }).versions.length, 1);
    const levels = [{ id: 'now', label: 'Now', definition: '' }, { id: 'later', label: 'Later', definition: '' }];
    const proposed = await call('PUT', '/v1/priorities', { token: agent, body: levels });
    assert.equal(proposed.status, 202, 'an agent proposes, and the person approves');
    assert.equal(((await (await call('GET', '/v1/priorities', { token: agent })).json()) as unknown[]).length, 3, 'nothing changes before approval');
    const card = ((await proposed.json()) as { proposed: { id: string } }).proposed;
    await call('POST', `/v1/cards/${card.id}/answer`, { token: owner, body: { values: { choice: 'approve' } } });
    assert.equal(((await (await call('GET', '/v1/priorities', { token: agent })).json()) as unknown[]).length, 2);
    assert.equal((await call('POST', '/v1/guidance', { token: agent, body: { text: 'Show diffs.' } })).status, 201);
    assert.equal((await call('PUT', '/v1/settings', { token: agent, body: { allowHtml: true } })).status, 403);
    assert.equal(((await (await call('PUT', '/v1/settings', { token: owner, body: { allowHtml: true } })).json()) as { allowHtml: boolean }).allowHtml, true);
  });
});

describe('message ids from review', () => {
  it('applies one of several simultaneous copies, and answers the others with the result or a retry', async () => {
    const { call, agent, inbox } = await setup();
    const send = () => call('POST', '/v1/cards', { token: agent, body: { agent: 's1', title: 'Same message at once' }, headers: { 'x-message-id': 'simultaneous-1' } });
    const all = await Promise.all([send(), send(), send(), send()]);
    for (const r of all) assert.ok([201, 409].includes(r.status), String(r.status));
    assert.equal(inbox.listCards({ token: 'x', role: 'owner' }).filter((c) => c.card.title === 'Same message at once').length, 1);
    const again = await send();
    assert.equal(again.headers.get('x-message-id-replayed'), '1');
  });
});

describe('limits a hosted inbox needs', () => {
  it('refuses a large body before it reads all of it, with a smaller limit on routes open without a token', async () => {
    const { call, agent } = await setup();
    assert.equal((await call('POST', '/v1/pair', { body: { name: 'x'.repeat(5000) } })).status, 413);
    assert.equal((await call('POST', '/v1/login', { headers: { 'content-length': '999999' }, body: {} })).status, 413);
    assert.equal((await call('POST', '/v1/templates', { token: agent, body: { name: 't', source: 'x'.repeat(1_100_000) } })).status, 413);
  });

  it('answers 507 to writes on a full inbox, and still takes the ones that free space', async () => {
    const inbox = new Inbox(new MemoryStorage(), Date.now, undefined, { storageLimitBytes: 3000 });
    const handle = createHandler(inbox);
    const owner = (await inbox.createToken('page', 'owner')).secret;
    const call = (method: string, path: string, body?: unknown) => handle(new Request(`http://inbox.test${path}`, { method, headers: { authorization: `Bearer ${owner}` }, body: body === undefined ? undefined : JSON.stringify(body) }));
    assert.equal((await call('POST', '/v1/cards', { id: 'big', agent: 'a', title: 'q', text: 'x'.repeat(4000) })).status, 201);
    assert.equal((await call('POST', '/v1/cards', { agent: 'a', title: 'one more' })).status, 507);
    assert.equal((await call('POST', '/v1/pair', { name: 'x' })).status, 507);
    assert.equal((await call('POST', '/v1/reset', { confirm: 'reset' })).status, 200);
    assert.equal((await call('POST', '/v1/cards', { agent: 'a', title: 'room again' })).status, 201);
  });

  it('serves no streams or long-polls when streams are off', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const handle = createHandler(inbox, { streams: false });
    const owner = (await inbox.createToken('page', 'owner')).secret;
    for (const path of ['/v1/events', '/v1/stream?agent=a', '/v1/poll?agent=a']) {
      assert.equal((await handle(new Request(`http://inbox.test${path}`, { headers: { authorization: `Bearer ${owner}` } }))).status, 410, path);
    }
  });
});

describe('signing a phone in', () => {
  it('turns a sign-in code into a cookie once, and only the owner gets codes', async () => {
    const { call, owner, agent } = await setup();
    assert.equal((await call('POST', '/v1/sign-in-codes', { token: agent })).status, 403);
    const { code } = (await (await call('POST', '/v1/sign-in-codes', { token: owner })).json()) as { code: string };
    const first = await call('POST', '/v1/login', { body: { code } });
    assert.equal(first.status, 200);
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.notEqual(cookie, `${COOKIE}=${encodeURIComponent(owner)}`, 'the phone gets its own token');
    assert.equal((await call('GET', '/v1/state', { headers: { cookie } })).status, 200);
    assert.equal((await call('POST', '/v1/login', { body: { code } })).status, 401);
  });
});

describe('network addresses', () => {
  it('tells the owner where a phone on the network reaches the inbox, and nobody else', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const handle = createHandler(inbox, { networkAddresses: () => ['http://laptop.local:4815', 'http://192.168.1.20:4815'] });
    const owner = (await inbox.createToken('page', 'owner')).secret;
    const agent = (await inbox.createToken('a', 'agent')).secret;
    const get = (token: string) => handle(new Request('http://inbox.test/v1/addresses', { headers: { authorization: `Bearer ${token}` } }));
    assert.deepEqual(await (await get(owner)).json(), { addresses: ['http://laptop.local:4815', 'http://192.168.1.20:4815'] });
    assert.equal((await get(agent)).status, 403);
  });

  it('focuses a session link for the owner only, and refuses an address that is not one', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const focused: string[] = [];
    const handle = createHandler(inbox, { focusSession: async (href) => { focused.push(href); } });
    const owner = (await inbox.createToken('page', 'owner')).secret;
    const agent = (await inbox.createToken('agents', 'agent')).secret;
    const post = (token: string, href: string) => handle(new Request('http://inbox.test/v1/focus', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ href }),
    }));
    assert.equal((await post(owner, 'https://herdr.invalid/v1/tab/w1:t2')).status, 200);
    assert.equal((await post(owner, 'https://example.com/')).status, 400);
    const nullBody = await handle(new Request('http://inbox.test/v1/focus', { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: 'null' }));
    assert.equal(nullBody.status, 400);
    assert.equal((await post(agent, 'https://herdr.invalid/v1/tab/w1:t2')).status, 403);
    assert.deepEqual(focused, ['https://herdr.invalid/v1/tab/w1:t2']);
    const hosted = createHandler(inbox);
    const res = await hosted(new Request('http://inbox.test/v1/focus', {
      method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ href: 'https://herdr.invalid/v1/tab/w1:t2' }),
    }));
    assert.equal(res.status, 501);
  });
});
