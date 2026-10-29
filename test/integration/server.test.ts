import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { ROOT, start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

const state = async () => (await (await h.owner('GET', '/v1/state')).json()) as { cards: Card[]; presence: Record<string, { online: boolean }>; states: Record<string, string> };

describe('the laptop server', () => {
  it('serves the page and the OpenUI bundle', async () => {
    const page = await fetch(`${h.server.url}/`);
    assert.match(await page.text(), /<title>Your Attention<\/title>/);
    const bundle = await fetch(`${h.server.url}/vendor/openui-bundle.min.js`);
    assert.equal(bundle.status, 200);
    assert.equal((await fetch(`${h.server.url}/../package.json`)).status, 404);
  });

  it('keeps serving after a client drops its connection in the middle of a request body', async () => {
    const { port } = new URL(h.server.url);
    const socket = net.connect(Number(port), '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('POST /v1/cards HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{"title":');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fetch(`${h.server.url}/`)).status, 200);
  });

  it('keeps its token files private to the user', () => {
    if (process.platform === 'win32') return;
    for (const f of ['owner-token', 'agent-token']) assert.equal(fs.statSync(path.join(h.home, f)).mode & 0o777, 0o600);
  });

  it('delivers an answer within a second, shows presence, and records the read receipt', async () => {
    const agent = new Client({ url: h.server.url, token: h.agentToken });
    await agent.post({ id: 'int-1', agent: 'session-1', title: 'Rename the module?', options: [{ id: 'o1', label: 'Yes' }] });
    const stop = new AbortController();
    const got: AgentEvent[] = [];
    void agent.stream('session-1', (ev) => { got.push(ev); }, stop.signal);
    await until(async () => (await state()).presence['session-1']?.online);
    const t0 = Date.now();
    await h.owner('POST', '/v1/cards/int-1/answer', { values: { choice: 'o1' }, comment: 'go' });
    const ev = await until(() => got.find((e) => e.type === 'answer'));
    assert.ok(Date.now() - t0 < 1000, 'the answer arrives within a second');
    assert.equal(ev.type === 'answer' && ev.answer.comment, 'go');
    assert.equal((await state()).states['int-1'], 'delivered');
    await agent.ack('int-1');
    assert.equal((await state()).states['int-1'], 'read');
    stop.abort();
    await until(async () => (await state()).presence['session-1']?.online === false || undefined);
  });

  it('streams page events when a card arrives', async () => {
    const res = await fetch(`${h.server.url}/v1/events`, { headers: { authorization: `Bearer ${h.server.ownerToken}` } });
    const reader = res.body!.getReader();
    await new Client({ url: h.server.url, token: h.agentToken }).post({ id: 'int-2', agent: 's2', title: 'New card' });
    let text = '';
    while (!text.includes('"card":"int-2"')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
  });

  it('runs `your-attention post --wait` end to end', async () => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'post', '--agent', 'cli-1', '--title', 'Deploy now?', '--option', 'Yes', '--option', 'No', '--wait'], {
      env: { ...process.env, YOUR_ATTENTION_HOME: h.home },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    const id = await until(() => out.split('\n')[0]?.trim() || undefined);
    await until(async () => (await state()).presence['cli-1']?.online);
    await h.owner('POST', `/v1/cards/${id}/answer`, { values: { choice: 'o2' }, comment: 'after lunch' });
    await new Promise((r) => child.on('exit', r));
    assert.match(out, /choice: No\nComment: after lunch/);
    assert.equal((await state()).states[id], 'read');
  });

  it('pairs a new client through a system card', async () => {
    const res = await fetch(`${h.server.url}/v1/pair`, { method: 'POST', body: JSON.stringify({ name: 'second laptop' }) });
    const { id, code } = (await res.json()) as { id: string; code: string };
    const card = (await state()).cards.find((c) => c.id === `pair-${id}`);
    assert.ok(card?.text?.includes(code));
    await h.owner('POST', `/v1/cards/pair-${id}/answer`, { values: { choice: 'approve' } });
    const { token } = (await (await fetch(`${h.server.url}/v1/pair/${id}`)).json()) as { token: string };
    const posted = await new Client({ url: h.server.url, token }).post({ agent: 'remote-1', title: 'Hello from the second laptop' });
    assert.equal(posted.title, 'Hello from the second laptop');
  });

  it('keeps every card and answer across a restart', async () => {
    const { serve } = await import('../../src/node/server.ts');
    await h.server.close();
    h.server = await serve({ port: 0, host: '127.0.0.1', home: h.home, mdns: false, watch: false, log: () => {} });
    const s = await state();
    assert.equal(s.states['int-1'], 'read');
    assert.equal(s.presence['session-1']?.online, false);
  });
});
