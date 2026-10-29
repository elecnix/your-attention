// Loads the pi extension against a stand-in for pi's ExtensionAPI.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import yourAttention from '../../src/integrations/pi/extension.ts';
import type { Card } from '../../src/core/types.ts';
import { seal } from '../../web/sealed.js';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => {
  h = await start();
  process.env['YOUR_ATTENTION_HOME'] = h.home;
});
after(async () => {
  await handlers.get('session_shutdown')?.({}, ctx);
  delete process.env['YOUR_ATTENTION_HOME'];
  await h.stop();
});

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler>();
const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
const sent: { text: string; options?: { deliverAs?: string } }[] = [];
let idle = true;
const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => 'pi-session-1', getCwd: () => '/repo', getSessionName: () => 'card inbox' } };
const pi = {
  on: (name: string, fn: Handler) => { handlers.set(name, fn); },
  registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }) => { tools.set(t.name, t); },
  sendUserMessage: (text: string, options?: { deliverAs?: string }) => { sent.push({ text, options }); },
};

const state = async () => (await h.stored()) as { states: Record<string, string>; presence: Record<string, { online: boolean }> };

describe('the pi extension', () => {
  it('registers the card tools and connects on session start', async () => {
    yourAttention(pi as never);
    assert.deepEqual([...tools.keys()].sort(), ['card_ask_secret', 'card_close', 'card_guidance', 'card_patch', 'card_post', 'card_reply', 'card_search', 'card_status', 'card_template_save', 'card_widget_save']);
    await handlers.get('session_start')?.({}, ctx);
    await until(async () => (await state()).presence['pi:pi-session-1']?.online);
  });

  it('starts a new turn with the answer when pi is idle, and marks it read from the context', async () => {
    const res = await tools.get('card_post')!.execute('call-1', { id: 'pi-1', title: 'Ship on Friday?', options: ['Yes', 'No'] }, undefined, undefined, ctx);
    assert.match(res.content[0]!.text, /Posted card pi-1/);
    await h.owner('POST', '/v1/cards/pi-1/answer', { values: { choice: 'o2' } });
    const msg = await until(() => sent.find((m) => m.text.includes('pi-1')));
    assert.equal(msg.options, undefined, 'an idle agent gets a new turn');
    assert.match(msg.text, /choice: No/);
    await handlers.get('context')?.({ messages: [{ role: 'user', content: msg.text }] }, ctx);
    await until(async () => (await state()).states['pi-1'] === 'read' || undefined);
  });

  it('opens a sealed secret into a private file, and tells the agent only the path', async () => {
    const res = await tools.get('card_ask_secret')!.execute('call-s', { name: 'PI_KEY', title: 'Need the pi key' }, undefined, undefined, ctx);
    const id = /card (\S+)\./.exec(res.content[0]!.text)?.[1];
    const card = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === id);
    await h.owner('POST', `/v1/cards/${id}/answer`, { values: { sealed: await seal(card!.secret!.publicKey, 'pi-value-not-real') } });
    const msg = await until(() => sent.find((m) => m.text.includes(String(id))));
    assert.doesNotMatch(msg.text, /pi-value-not-real/);
    const file = /It is in (\S+), which/.exec(msg.text)?.[1];
    assert.equal(fs.readFileSync(String(file), 'utf8'), 'pi-value-not-real');
  });

  it('steers a busy agent, and queues an answer marked as a follow-up', async () => {
    idle = false;
    await tools.get('card_post')!.execute('call-2', { id: 'pi-2', title: 'Rename it?' }, undefined, undefined, ctx);
    await h.owner('POST', '/v1/cards/pi-2/answer', { comment: 'yes' });
    assert.equal((await until(() => sent.find((m) => m.text.includes('pi-2')))).options?.deliverAs, 'steer');
    await tools.get('card_post')!.execute('call-3', { id: 'pi-3', title: 'Tests too?' }, undefined, undefined, ctx);
    await h.owner('POST', '/v1/cards/pi-3/answer', { comment: 'later', delivery: 'followUp' });
    assert.equal((await until(() => sent.find((m) => m.text.includes('pi-3')))).options?.deliverAs, 'followUp');
  });
});
