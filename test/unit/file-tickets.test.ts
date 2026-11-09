// A folder ticket opens the HTML file a card names, and the files in its folder, in a new tab that carries no credential.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { localFile } from '../../src/adapters/files.ts';
import { folderFilePath } from '../../src/core/file-links.ts';
import { COOKIE, createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { UNLOCK_HEADER, pinKey } from '../../src/core/pin.ts';
import { MemoryStorage } from '../../src/core/storage.ts';

/** Stand-in files, each holding its own path. `asked` records each path and folder the handler asked for. */
const FILES = ['/srv/site/report.html', '/srv/site/style.css', '/srv/site/img/logo.png', '/srv/site/fonts/a.woff2', '/srv/site/notes.txt', '/srv/secret.txt', '/srv/site/.env'];
const asked: [string, string | undefined][] = [];
const localFiles = {
  host: 'laptop',
  file: async (p: string, folder?: string) => {
    asked.push([p, folder]);
    if (!FILES.includes(p)) return undefined;
    return { size: p.length, read: async () => new TextEncoder().encode(p) as Uint8Array<ArrayBuffer> };
  },
};

async function setup(options: { files?: boolean } = {}) {
  const inbox = new Inbox(new MemoryStorage(), Date.now, undefined, { pinIterations: 1000 });
  const handle = createHandler(inbox, options.files === false ? {} : { localFiles });
  const link = (await inbox.createToken('device', 'owner')).secret;
  const agent = (await inbox.createToken('agents', 'agent')).secret;
  const call = (method: string, route: string, opts: { token?: string; cookie?: string; unlock?: string; body?: unknown } = {}) =>
    handle(new Request(`http://inbox.test${route}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.cookie ? { cookie: `${COOKIE}=${encodeURIComponent(opts.cookie)}`, 'x-your-attention': '1' } : {}),
        ...(opts.unlock ? { [UNLOCK_HEADER]: opts.unlock } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }));
  await call('POST', '/v1/cards', { token: agent, body: { id: 'c1', agent: 's', title: 'q', origin: { host: 'laptop' },
    text: 'See file:///srv/site/report.html and file:///srv/site/notes.txt' } });
  /** A ticket the page asks for, and the address of a file under it. Each segment of `rest` goes in the address as it is. */
  const ticket = async (p: string, opts: { unlock?: string } = {}) => {
    const res = await call('POST', '/v1/cards/c1/file-ticket', { cookie: link, unlock: opts.unlock, body: { path: p } });
    return { status: res.status, ...((await res.json()) as { ticket: string; name: string }) };
  };
  // A new tab sends no credential of its own: the ticket in the address is the credential.
  const open = (t: string, rest: string) => call('GET', `/v1/files/${t}/${rest}`);
  return { inbox, call, link, agent, ticket, open };
}

describe('a folder ticket', () => {
  it('opens the HTML file a card names, and the stylesheets, images and fonts in its folder, without a cookie', async () => {
    const { ticket, open } = await setup();
    const t = await ticket('/srv/site/report.html');
    assert.equal(t.status, 201);
    assert.equal(t.name, 'report.html');
    const page = await open(t.ticket, 'report.html');
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '/srv/site/report.html');
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    for (const [rest, file] of [['style.css', '/srv/site/style.css'], ['img/logo.png', '/srv/site/img/logo.png'], ['fonts/a.woff2', '/srv/site/fonts/a.woff2']]) {
      const res = await open(t.ticket, rest!);
      assert.equal(res.status, 200, rest);
      assert.equal(await res.text(), file);
    }
    assert.equal((await open(t.ticket, 'style.css')).headers.get('content-type'), 'text/css; charset=utf-8');
    // A font loads in CORS mode from the page's opaque origin, so it needs an allow-origin header to draw.
    assert.equal((await open(t.ticket, 'fonts/a.woff2')).headers.get('access-control-allow-origin'), '*');
  });

  it('asks the file system for each asset inside the ticket folder, so a symlink that leaves it is refused there', async () => {
    const { ticket, open } = await setup();
    const t = await ticket('/srv/site/report.html');
    asked.length = 0;
    await open(t.ticket, 'img/logo.png');
    assert.deepEqual(asked, [['/srv/site/img/logo.png', '/srv/site']]);
  });

  it('allows embedded images and fonts and the folder, and still blocks every script with the sandbox', async () => {
    const { ticket, open } = await setup();
    const csp = (await open((await ticket('/srv/site/report.html')).ticket, 'report.html')).headers.get('content-security-policy') ?? '';
    assert.match(csp, /^sandbox; default-src 'none';/);
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /font-src 'self' data: blob:/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.doesNotMatch(csp, /script-src/);
  });

  it('refuses a path that leaves the folder: dot segments, encoded or not, an absolute path, and the parent folder', async () => {
    const { ticket, open } = await setup();
    const t = (await ticket('/srv/site/report.html')).ticket;
    asked.length = 0;
    for (const rest of ['..%2Fsecret.txt', '%2e%2e%2Fsecret.txt', '..%5Csecret.txt', 'img%2F..%2F..%2Fsecret.txt', '%2Fsrv%2Fsecret.txt', '/srv/secret.txt', '', 'img/', '%00report.html']) {
      const res = await open(t, rest);
      assert.equal(res.status, 403, rest);
    }
    // The URL parser resolves a plain or encoded dot segment before the route reads it, so the ticket drops out of the address.
    for (const rest of ['../secret.txt', '%2e%2e/secret.txt', '..', 'img/../../secret.txt']) {
      const res = await open(t, rest);
      assert.notEqual(res.status, 200, rest);
      assert.doesNotMatch(await res.text(), /secret/, rest);
    }
    assert.deepEqual(asked, [], 'no refused path reaches the file system');
  });

  it('refuses hidden files and folders, such as .env or .git, which a page has no reason to load', async () => {
    const { ticket, open } = await setup();
    const t = (await ticket('/srv/site/report.html')).ticket;
    assert.equal((await open(t, '.env')).status, 403);
    assert.equal((await open(t, '.git/config')).status, 403);
  });

  it('opens only its own file when the card names a file that is not HTML', async () => {
    const { ticket, open } = await setup();
    const t = (await ticket('/srv/site/notes.txt')).ticket;
    assert.equal(await (await open(t, 'notes.txt')).text(), '/srv/site/notes.txt');
    assert.equal((await open(t, 'style.css')).status, 403);
  });

  it('refuses a ticket for a file the card does not name, and an unknown ticket', async () => {
    const { ticket, open } = await setup();
    assert.equal((await ticket('/srv/site/style.css')).status, 403);
    assert.equal((await open('0123456789abcdef', 'report.html')).status, 403);
  });

  it('gives the same page the same ticket for the same file', async () => {
    const { ticket } = await setup();
    assert.equal((await ticket('/srv/site/report.html')).ticket, (await ticket('/srv/site/report.html')).ticket);
  });

  it('ends when the card is cleared or removed', async () => {
    const { ticket, open, call, link, agent } = await setup();
    const t = (await ticket('/srv/site/report.html')).ticket;
    await call('POST', '/v1/cards/c1/close', { token: agent, body: { kind: 'retracted', outcome: 'done' } });
    assert.equal((await open(t, 'report.html')).status, 200, 'a closed card is still in the inbox');
    assert.equal((await call('POST', '/v1/archive', { cookie: link, body: {} })).status, 200);
    assert.equal((await open(t, 'report.html')).status, 403);
  });

  it('ends when an edit takes the file out of the card', async () => {
    const { ticket, open, call, agent } = await setup();
    const t = (await ticket('/srv/site/report.html')).ticket;
    const edits = [{ old: 'file:///srv/site/report.html and ', new: '' }];
    assert.equal((await call('POST', '/v1/cards/c1/patch', { token: agent, body: { edits } })).status, 200);
    assert.equal((await open(t, 'report.html')).status, 403);
  });

  it('ends when the device that asked for it signs out', async () => {
    const { ticket, open, inbox } = await setup();
    const t = (await ticket('/srv/site/report.html')).ticket;
    const device = inbox.listTokens().find((k) => k.name === 'device')!;
    inbox.revokeToken(device.id);
    assert.equal((await open(t, 'report.html')).status, 403);
  });

  it('with a PIN, works only while the unlock of the page that asked for it is live', async () => {
    const { ticket, open, call, link, inbox } = await setup();
    const before = (await ticket('/srv/site/report.html')).ticket;
    await inbox.pin.set('2468');
    assert.equal((await open(before, 'report.html')).status, 403, 'a ticket from before the PIN ends with it');
    assert.equal((await ticket('/srv/site/report.html')).status, 423, 'a locked page gets no ticket');
    const key = await pinKey('2468', inbox.pin.status().salt ?? '', inbox.pin.status().iterations);
    const { unlock } = (await (await call('POST', '/v1/unlock', { cookie: link, body: { key } })).json()) as { unlock: string };
    const t = (await ticket('/srv/site/report.html', { unlock })).ticket;
    assert.equal((await open(t, 'report.html')).status, 200);
    assert.equal((await open(t, 'img/logo.png')).status, 200);
    await call('POST', '/v1/lock', { cookie: link, unlock });
    assert.equal((await open(t, 'report.html')).status, 403);
  });

  it('sends a file link opened without a ticket to a fresh folder ticket, while the inbox has no PIN', async () => {
    const { call, link, open } = await setup();
    const res = await call('GET', `/v1/cards/c1/file?path=${encodeURIComponent('/srv/site/report.html')}`, { cookie: link });
    assert.equal(res.status, 303);
    const location = new URL(res.headers.get('location') ?? '', 'http://inbox.test/v1/cards/c1/file');
    const [, , , t, rest] = location.pathname.split('/');
    assert.equal(location.pathname, `/v1/files/${t}/report.html`);
    assert.equal(await (await open(t!, rest!)).text(), '/srv/site/report.html');
    assert.equal((await call('GET', `/v1/cards/c1/file?path=${encodeURIComponent('/srv/site/style.css')}`, { cookie: link })).status, 403);
  });

  it('answers 404 on an inbox with no file system, as the hosted one', async () => {
    const { open } = await setup({ files: false });
    assert.equal((await open('0123456789abcdef', 'report.html')).status, 404);
  });
});

describe('the path under a ticket folder', () => {
  it('joins each decoded segment under the folder', () => {
    assert.equal(folderFilePath('/srv/site', 'img/My%20Logo.png'), '/srv/site/img/My Logo.png');
    assert.equal(folderFilePath('/', 'report.html'), '/report.html');
  });

  it('refuses dot segments, encoded slashes and backslashes, empty segments, NUL and malformed escapes', () => {
    for (const rest of ['..', '%2e%2e', '.', 'a/../b', '..%2Fb', 'a%2Fb', 'a%5Cb', '/etc/passwd', 'a//b', '', 'a/', '%00', 'a%zz', '.hidden']) {
      assert.equal(folderFilePath('/srv/site', rest), undefined, rest);
    }
  });
});

describe('a local file read inside a folder', () => {
  let dir: string;
  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ya-folder-')));
    fs.mkdirSync(path.join(dir, 'site', 'img'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'site', 'report.html'), '<h1>r</h1>');
    fs.writeFileSync(path.join(dir, 'site', 'img', 'logo.png'), 'png');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'site', 'leak.txt'));
    fs.symlinkSync(dir, path.join(dir, 'site', 'up'));
    fs.symlinkSync(path.join(dir, 'site', 'img', 'logo.png'), path.join(dir, 'site', 'alias.png'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const site = () => path.join(dir, 'site');

  it('reads a file in the folder or below it, also through a symlink that stays inside', async () => {
    assert.equal(new TextDecoder().decode(await (await localFile(path.join(site(), 'img', 'logo.png'), site()))!.read()), 'png');
    assert.equal(new TextDecoder().decode(await (await localFile(path.join(site(), 'alias.png'), site()))!.read()), 'png');
  });

  it('refuses a symlink to a file outside the folder, a symlink to the parent folder, and the parent folder itself', async () => {
    assert.equal(await localFile(path.join(site(), 'leak.txt'), site()), undefined);
    assert.equal(await localFile(path.join(site(), 'up', 'secret.txt'), site()), undefined);
    assert.equal(await localFile(path.join(dir, 'secret.txt'), site()), undefined);
    assert.equal(await localFile(path.join(site(), '..', 'secret.txt'), site()), undefined);
    assert.equal(await localFile(site(), site()), undefined);
  });

  it('still reads a named file through a symlink when no folder confines it', async () => {
    assert.equal(new TextDecoder().decode(await (await localFile(path.join(site(), 'leak.txt')))!.read()), 'secret');
  });
});
