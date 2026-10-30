// `your-attention tui` on a real inbox, in a pseudo-terminal: keys and mouse reports go in, the screen comes out,
// and the agent receives the answer the page would send.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import type { NewCard, Sealed } from '../../src/core/types.ts';
import { start, until, type Harness } from './harness.ts';
import { startTui, type Tui } from './tui-pty.ts';

// A stand-in for herdr that records each command, so a session link in a test never reaches a real herdr.
const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-tui-herdr-'));
const herdrCalls = path.join(herdrDir, 'calls');
fs.writeFileSync(path.join(herdrDir, 'herdr'), `#!/bin/sh\necho "$*" >> '${herdrCalls}'\necho '{}'\n`, { mode: 0o755 });
process.env['HERDR_BIN_PATH'] = path.join(herdrDir, 'herdr');

let h: Harness;
let agent: Client;
const running: Tui[] = [];
const tui = (opts: Partial<Parameters<typeof startTui>[0]> = {}): Tui => {
  const t = startTui({ url: h.server.url, token: h.server.ownerToken, ...opts });
  running.push(t);
  return t;
};
/** Answers for one agent, as they arrive. */
const listen = (id: string) => {
  const { events, stop } = h.listen(agent, id);
  return { answer: () => until(() => events.find((e) => e.type === 'answer'), 8000), stop };
};
const post = (c: NewCard) => agent.post(c);

/** A proxy in front of the inbox that holds GET /v1/cards/<id> for the cards in `held` until `release`, so a test can act
 * on a card whose fields have not loaded. Everything else, the page socket too, goes through as it came. */
async function slowCards(target: string, held: string[]) {
  const waiting: (() => void)[] = [];
  // A socket that upgraded leaves the server's connections, so close() ends each one itself.
  const upgraded = new Set<net.Socket>();
  let released = false;
  const server = http.createServer((req, res) => {
    const forward = () => {
      const up = http.request(`${target}${req.url}`, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on('error', () => res.destroy());
      req.pipe(up);
    };
    const id = /^\/v1\/cards\/([^/?]+)$/.exec(req.url ?? '')?.[1];
    if (req.method === 'GET' && id && held.includes(decodeURIComponent(id)) && !released) waiting.push(forward);
    else forward();
  });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(target);
    const up = net.connect(Number(u.port), u.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      up.write(head);
      socket.pipe(up).pipe(socket);
    });
    upgraded.add(socket as net.Socket).add(up);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    release: () => { released = true; for (const f of waiting.splice(0)) f(); },
    close: () => new Promise<void>((r) => {
      for (const sock of upgraded) sock.destroy();
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

before(async () => {
  h = await start();
  agent = new Client({ url: h.server.url, token: h.agentToken });
});
// A test that fails stops before its own cleanup, so each one's clients stop here, and a failure never leaves a process behind.
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop();
});
after(async () => {
  await h.stop();
  fs.rmSync(herdrDir, { recursive: true, force: true });
});

describe('your-attention tui', () => {
  it('answers a card from the keyboard, and the agent gets the values the page sends', async () => {
    await post({ id: 'kb', agent: 's-kb', title: 'Which database?', priority: 'now', options: [{ id: 'o1', label: 'SQLite' }, { id: 'o2', label: 'Postgres' }] });
    const ev = listen('s-kb');
    const t = tui();
    await t.waitFor('Which database?');
    await t.waitFor('( ) Postgres');
    t.send('\r');
    t.send('\x1b[B');
    t.send(' ');
    await t.waitFor('(•) Postgres');
    t.send('\t');
    t.send('after the release');
    await t.waitFor('after the release');
    t.send('\x13');
    const a = await ev.answer();
    assert.ok(a.type === 'answer');
    assert.deepEqual(a.answer.values, { choice: 'o2' });
    assert.equal(a.answer.comment, 'after the release');
    ev.stop();
    await t.stop();
  });

  it('answers a body form with the mouse: a click opens the card, picks the fields and sends', async () => {
    const body = 'root = Card([f])\nf = Form("f", b, [c1, c2])\nb = Buttons([])\nc1 = FormControl("Merge #12?", RadioGroup("merge12", [RadioItem("Merge it", "", "yes"), RadioItem("Wait", "", "no")]))\nc2 = FormControl("Checks", CheckBoxGroup("checks", [CheckBoxItem("Rerun CI", "", "ci"), CheckBoxItem("Ask a reviewer", "", "review")]))';
    await post({ id: 'mouse', agent: 's-mouse', title: 'Mouse card', priority: 'later', body });
    const ev = listen('s-mouse');
    const t = tui();
    const row = await t.waitFor('Mouse card');
    t.click(row.x + 2, row.y);
    t.click((await t.waitFor('Merge it')).x, (await t.waitFor('Merge it')).y);
    await t.waitFor('(•) Merge it');
    const ci = await t.waitFor('Rerun CI');
    t.click(ci.x, ci.y);
    await t.waitFor('[x] Rerun CI');
    const send = await t.waitFor('[ Send answer ]');
    t.click(send.x + 3, send.y);
    const a = await ev.answer();
    assert.ok(a.type === 'answer');
    assert.deepEqual(a.answer.values, { merge12: 'yes', checks: { ci: true, review: false } });
    ev.stop();
    await t.stop();
  });

  it('sends with Ctrl+Enter as the kitty keyboard protocol and modifyOtherKeys report it', async () => {
    await post({ id: 'ce1', agent: 's-ce', title: 'Ctrl Enter one', priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
    const ev = listen('s-ce');
    const t = tui();
    await t.waitFor('Ctrl Enter one');
    // The list shows a card before its fields load, and Enter on a card that has not loaded does nothing.
    await t.waitFor('( ) Yes');
    t.send('\r ');
    await t.waitFor('(•) Yes');
    t.send('\x1b[13;5u');
    const a = await ev.answer();
    assert.ok(a.type === 'answer' && a.answer.card === 'ce1');
    await post({ id: 'ce2', agent: 's-ce2', title: 'Ctrl Enter two', priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
    const ev2 = listen('s-ce2');
    // The answer opens the next card, and Enter goes to its first field.
    await t.waitFor('Ctrl Enter two new');
    await t.waitFor('( ) Yes');
    t.send('\r ');
    await t.waitFor('(•) Yes');
    t.send('\x1b[27;5;13~');
    const b = await ev2.answer();
    assert.ok(b.type === 'answer' && b.answer.card === 'ce2');
    ev.stop();
    ev2.stop();
    await t.stop();
  });

  it('seals a secret in the client, so the inbox stores only what the agent key opens, and never shows the value', async () => {
    const keys = await newSealKeys();
    await post({ id: 'secret', agent: 's-secret', kind: 'secret', title: 'The deploy key', priority: 'now', secret: { name: 'DEPLOY_KEY', publicKey: keys.publicKey } });
    const ev = listen('s-secret');
    const t = tui();
    const row = await t.waitFor('The deploy key');
    t.click(row.x, row.y);
    await t.waitFor('[ Send sealed ]');
    t.send('\r');
    t.send('sk-test-123');
    await t.waitFor('•••••••••••');
    assert.equal(t.vt.text().includes('sk-test-123'), false);
    t.send('\x13');
    const a = await ev.answer();
    assert.ok(a.type === 'answer');
    assert.equal(await openSealed(keys.privateKey, a.answer.values['sealed'] as Sealed), 'sk-test-123');
    ev.stop();
    await t.stop();
  });

  it('asks for the PIN of a locked inbox, never shows it, and answers with the unlock token after', async () => {
    const own = await start();
    try {
      // The inbox refuses a PIN sent as it is, so the unlock below works only with the key the terminal derives.
      await own.server.inbox.pin.set('2468');
      // An owner token that is not the laptop's file, like a sign-in link's, needs the PIN.
      const { secret } = await own.server.inbox.createToken('tui test', 'owner');
      const ownAgent = new Client({ url: own.server.url, token: own.agentToken });
      await ownAgent.post({ id: 'locked', agent: 's-locked', title: 'Behind the PIN', priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
      const { events, stop } = own.listen(ownAgent, 's-locked');
      const t = startTui({ url: own.server.url, token: secret });
      running.push(t);
      await t.waitFor('This inbox is locked. Type its PIN:');
      t.send('1111\r');
      await t.waitFor('Wrong PIN. 4 tries left.');
      t.send('2468\r');
      await t.waitFor('Behind the PIN');
      await t.waitFor('( ) Yes');
      t.send('\r ');
      await t.waitFor('(•) Yes');
      t.send('\x13');
      const a = await until(() => events.find((e) => e.type === 'answer'), 8000);
      assert.ok(a.type === 'answer' && a.answer.values['choice'] === 'y');
      assert.equal(t.vt.raw.includes('2468'), false, 'the PIN never reaches the screen');
      stop();
      await t.stop();
    } finally {
      await own.stop();
    }
  });

  it('enters a card once its fields load, after Enter while it loaded', async () => {
    await post({ id: 'late', agent: 's-late', title: 'Late fields', priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
    const proxy = await slowCards(h.server.url, ['late']);
    try {
      const t = tui({ url: proxy.url });
      await t.waitFor('Loading Late fields…');
      t.send('\r');
      await t.waitFor('Loading the card…');
      proxy.release();
      await t.waitFor('( ) Yes');
      // In the list, Space enters the card. Only a field that has focus picks.
      t.send(' ');
      await t.waitFor('(•) Yes');
    } finally {
      await proxy.close();
      await agent.close('late', 'retracted', 'test over');
    }
  });

  it('drops a waiting Enter when the person moves to another card first', async () => {
    await post({ id: 'wait1', agent: 's-wait', title: 'Wait first', priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
    await post({ id: 'wait2', agent: 's-wait2', title: 'Wait second', priority: 'now', options: [{ id: 'y', label: 'Yes' }] });
    const proxy = await slowCards(h.server.url, ['wait1', 'wait2']);
    try {
      const t = tui({ url: proxy.url });
      const row = await t.waitFor('Wait first');
      t.click(row.x, row.y);
      await t.waitFor('Loading Wait first…');
      t.send('\r');
      await t.waitFor('Loading the card…');
      t.send('j');
      await t.waitFor('Loading Wait second…');
      proxy.release();
      await t.waitFor('( ) Yes');
      await t.waitFor('↑↓ cards');
    } finally {
      await proxy.close();
      for (const id of ['wait1', 'wait2']) await agent.close(id, 'retracted', 'test over');
    }
  });

  it('shows a new card and an agent reply live, without a restart', async () => {
    const t = tui();
    await t.waitFor('Your attention');
    await t.waitFor('Inbox connected');
    await post({ id: 'live', agent: 's-live', title: 'Arrived while open', priority: 'now', text: 'Posted after the client started.' });
    await t.waitFor('Arrived while open');
    await t.waitFor('new');
    await agent.reply('live', 'One more detail from the agent.');
    await t.waitFor('Agent replied');
    await t.stop();
  });

  // The stand-in for herdr is a shell script, which Windows does not run.
  it('opens a herdr session link through the inbox, which focuses that tab', { skip: process.platform === 'win32' }, async () => {
    await post({ id: 'link', agent: 's-link', title: 'Look at the release agent', priority: 'now', text: 'See [the release agent](https://herdr.invalid/v1/tab/w7:t3).' });
    const t = tui();
    const row = await t.waitFor('Look at the release');
    t.click(row.x, row.y);
    await t.waitFor('Look at the release agent');
    const link = await t.waitFor('the release agent.');
    t.click(link.x + 2, link.y);
    await until(() => (fs.existsSync(herdrCalls) && fs.readFileSync(herdrCalls, 'utf8').includes('tab focus w7:t3')) || undefined);
    await t.waitFor('Opened in herdr');
    await t.stop();
  });

  it('draws without color under NO_COLOR, and keeps a symbol, a word and inverse video for each state', async () => {
    const t = tui({ env: { NO_COLOR: '1', COLORTERM: 'truecolor' }, cols: 80, rows: 30 });
    await t.waitFor('Waiting for you');
    await new Promise((r) => setTimeout(r, 300));
    const colors = [...t.vt.raw.matchAll(/\x1b\[([\d;]*)m/g)].flatMap((m) => m[1]!.split(';').map(Number)).filter((n) => (n >= 30 && n <= 49) || (n >= 90 && n <= 107));
    assert.deepEqual(colors, []);
    const marker = t.vt.find('▶ ');
    assert.ok(marker, t.vt.text());
    assert.equal(t.vt.cell(marker.x, marker.y)?.inverse, true);
    assert.match(t.vt.text(), /[◉●↩] (now|soon|later) /);
    await t.stop();
  });

  it('fits a narrow pane of 80 columns with the list and the card side by side, and ASCII symbols with --ascii', async () => {
    const t = tui({ cols: 80, rows: 30, args: ['--ascii'] });
    await t.waitFor('Waiting for you');
    const lines = t.vt.lines();
    assert.ok(lines.every((l) => l.length <= 80));
    assert.ok(lines.some((l) => /^> [@<*] (now|soon|later)/.test(l)), t.vt.text());
    assert.ok(lines.some((l) => l.includes('|')), 'the panes have a border between them');
    await t.stop();
  });

  it('puts the terminal back on quit and when the process is stopped', async () => {
    const t = tui();
    await t.waitFor('Waiting for you');
    assert.ok(t.vt.modes.has(1049) && t.vt.modes.has(1006) && t.vt.modes.has(2004));
    t.send('q');
    await until(() => (t.vt.modes.has(1049) ? undefined : true));
    assert.equal(t.vt.modes.has(1000) || t.vt.modes.has(1006) || t.vt.modes.has(2004) || t.vt.modes.has(1004), false);
    // Windows has no signal a process can catch for this, so only the quit half runs there.
    if (process.platform === 'win32') return;
    const u = tui();
    await u.waitFor('Waiting for you');
    const pid = (u.events().find((e) => e.event === 'start') as { pid?: number } | undefined)?.pid;
    assert.ok(pid);
    process.kill(pid, 'SIGTERM');
    await until(() => (u.vt.modes.has(1049) ? undefined : true));
    assert.equal(u.vt.modes.has(1006), false);
  });

  it('paints 200 cards fast, and writes only what changed after a keypress', async () => {
    for (let i = 0; i < 200; i++) await post({ id: `bulk-${i}`, agent: `s-bulk-${i % 9}`, title: `Bulk card ${i}`, priority: ['now', 'soon', 'later'][i % 3], text: `Card ${i} with **bold** text.`, options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] });
    const t = tui();
    await t.waitFor('Bulk card');
    const paint = await until(() => t.events().find((e) => e.event === 'first-paint'));
    // The process start counts: Node, the modules and the first state request. Machines in CI are slower, so the
    // bound here is loose; README.md gives the time on a laptop.
    assert.ok(paint.ms < 1500, `first paint at ${paint.ms} ms`);
    assert.ok(Number(paint['cards']) >= 200);
    const before = t.events().filter((e) => e.event === 'frame').length;
    t.send('j');
    await until(() => (t.events().filter((e) => e.event === 'frame').length > before ? true : undefined));
    const frame = t.events().filter((e) => e.event === 'frame').at(-1)!;
    assert.ok(Number(frame['bytes']) < Number(paint['bytes']), `a keypress wrote ${frame['bytes']} bytes, the first paint ${paint['bytes']}`);
    await t.stop();
  });
});
