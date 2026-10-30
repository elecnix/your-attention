// The laptop inbox serves the owner a file on this machine that a card names with a file: address.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { MAX_ATTACHMENT_BYTES } from '../../src/core/inbox.ts';
import { start, type Harness } from './harness.ts';

let h: Harness;
let dir: string;
let agent: Client;
before(async () => {
  h = await start();
  agent = new Client({ url: h.server.url, token: h.agentToken });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-files-'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain notes');
  fs.writeFileSync(path.join(dir, 'report.html'), '<h1>Report</h1>');
  fs.writeFileSync(path.join(dir, 'My Report.md'), '# Mine');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not named');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'named through sub');
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  fs.mkdirSync(path.join(dir, 'sub'));
});
after(async () => { await h.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const url = (name: string): string => pathToFileURL(path.join(dir, name)).href;
/** The path the page sends: the decoded path of the file: address. */
const pathOf = (href: string): string => decodeURIComponent(new URL(href).pathname);
const fileRoute = (card: string, p: string): string => `/v1/cards/${card}/file?path=${encodeURIComponent(p)}`;
const here = os.hostname();

describe('file links on the laptop inbox', () => {
  before(async () => {
    await agent.post({ id: 'files', agent: 's1', title: 'Read the report', origin: { host: here },
      text: `The notes: ${url('notes.txt')}. The [report](${url('report.html')}), ${url('My Report.md')}, ${url('sub')}, ${url('gone.txt')} and ${url('big.bin')}.`,
      recommendation: `Also ${pathToFileURL(dir).href}/sub/../other.txt` });
    await agent.post({ id: 'elsewhere', agent: 's1', title: 'From another machine', origin: { host: `not-${here}` }, text: `See ${url('notes.txt')}` });
  });

  it('serves a named file to the owner, with its type, in a sandbox that runs no script', async () => {
    const res = await h.owner('GET', fileRoute('files', pathOf(url('notes.txt'))));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'plain notes');
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(res.headers.get('content-security-policy') ?? '', /^sandbox;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const html = await h.owner('GET', fileRoute('files', pathOf(url('report.html'))));
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(html.headers.get('content-security-policy') ?? '', /^sandbox;/);
    assert.equal(await html.text(), '<h1>Report</h1>');
  });

  it('marks the card it serves files for, and no card from another machine', async () => {
    assert.equal(((await (await h.owner('GET', '/v1/cards/files')).json()) as { card: { localFiles?: boolean } }).card.localFiles, true);
    assert.equal(((await (await h.owner('GET', '/v1/cards/elsewhere')).json()) as { card: { localFiles?: boolean } }).card.localFiles, undefined);
  });

  it('decodes the address, so a name with a space is served by its decoded path only', async () => {
    assert.equal(await (await h.owner('GET', fileRoute('files', pathOf(url('My Report.md'))))).text(), '# Mine');
    assert.equal((await h.owner('GET', fileRoute('files', path.join(dir, 'My%20Report.md').replaceAll('\\', '/')))).status, 403);
  });

  it('refuses a file the card does not name, also through a dot segment', async () => {
    assert.equal((await h.owner('GET', fileRoute('files', pathOf(url('secret.txt'))))).status, 403);
    assert.equal((await h.owner('GET', fileRoute('files', `${pathOf(url('sub'))}/../secret.txt`))).status, 403);
    // The card's own dot segment resolves to the file it names.
    assert.equal(await (await h.owner('GET', fileRoute('files', pathOf(url('other.txt'))))).text(), 'named through sub');
  });

  it('refuses a card that came from another machine', async () => {
    assert.equal((await h.owner('GET', fileRoute('elsewhere', pathOf(url('notes.txt'))))).status, 403);
  });

  it('serves the owner only', async () => {
    const res = await fetch(`${h.server.url}${fileRoute('files', pathOf(url('notes.txt')))}`, { headers: { authorization: `Bearer ${h.agentToken}` } });
    assert.equal(res.status, 403);
  });

  it('answers 404 for a directory and a missing file, and 413 for a file over the attachment limit', async () => {
    assert.equal((await h.owner('GET', fileRoute('files', pathOf(url('sub'))))).status, 404);
    assert.equal((await h.owner('GET', fileRoute('files', pathOf(url('gone.txt'))))).status, 404);
    assert.equal((await h.owner('GET', fileRoute('files', pathOf(url('big.bin'))))).status, 413);
  });

  it('opens in a new tab with the sign-in cookie, which carries no bearer header', async () => {
    const login = await fetch(`${h.server.url}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.server.ownerToken }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const res = await fetch(`${h.server.url}${fileRoute('files', pathOf(url('notes.txt')))}`, { headers: { cookie } });
    assert.equal(res.status, 200);
  });
});
