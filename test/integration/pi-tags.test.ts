// A pi session launched with --tags gets its default tags at session start, and every card it posts inherits them.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import yourAttention from '../../src/integrations/pi/extension.ts';
import type { Card } from '../../src/core/types.ts';
import { callAt, start, until, type Harness } from './harness.ts';

let h: Harness;
// The card's origin reads the herdr pane of the process that posts it, which here is the terminal that runs the tests.
const saved = { pane: process.env['HERDR_PANE_ID'], tags: process.env['YOUR_ATTENTION_TAGS'] };
before(async () => {
  h = await start();
  process.env['YOUR_ATTENTION_HOME'] = h.home;
  process.env['YOUR_ATTENTION_TAGS'] = 'repo=acme/store,topic=billing';
  delete process.env['HERDR_PANE_ID'];
});
after(async () => {
  await handlers.get('session_shutdown')?.({}, ctx);
  delete process.env['YOUR_ATTENTION_HOME'];
  for (const [k, v] of [['HERDR_PANE_ID', saved.pane], ['YOUR_ATTENTION_TAGS', saved.tags]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await h.stop();
});

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler>();
const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => 'pi-tags-1', getCwd: () => '/repo', getSessionName: () => 'billing agent' } };
const pi = {
  on: (name: string, handler: Handler) => { handlers.set(name, handler); },
  registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }) => { tools.set(t.name, t); },
  sendUserMessage: () => {},
};

const defaults = async (agent: string) => ((await (await callAt(h.server.url, h.agentToken, 'GET', `/v1/tags?agent=${encodeURIComponent(agent)}`)).json()) as { tags: Record<string, { value: string; from: string }> }).tags;
const card = async (id: string) => ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === id);

describe('a pi session launched with --tags', () => {
  it('holds the tags as its defaults, and a card it posts inherits them', async () => {
    yourAttention(pi as never);
    await handlers.get('session_start')?.({}, ctx);
    // The extension sets them as the session starts, over the inbox it also streams from.
    await until(async () => Object.keys(await defaults('pi:pi-tags-1')).length === 2);
    assert.deepEqual(await defaults('pi:pi-tags-1'), {
      repo: { value: 'acme/store', from: 'YOUR_ATTENTION_TAGS' },
      topic: { value: 'billing', from: 'YOUR_ATTENTION_TAGS' },
    });
    const posted = await tools.get('card_post')!.execute('c1', { id: 'tagged-1', title: 'Which store?' }, undefined, undefined, ctx);
    assert.match(posted.content[0]!.text, /It took the default tags repo, topic\./);
    assert.deepEqual((await card('tagged-1'))?.tags, { repo: 'acme/store', topic: 'billing' });
  });

  it('reads the tags back after a compaction, and a card can drop one of them', async () => {
    const read = await tools.get('card_tags')!.execute('c2', {}, undefined, undefined, ctx);
    assert.match(read.content[0]!.text, /repo: acme\/store \(from YOUR_ATTENTION_TAGS\)/);
    assert.match(read.content[0]!.text, /topic: billing \(from YOUR_ATTENTION_TAGS\)/);
    await tools.get('card_post')!.execute('c3', { id: 'tagged-2', title: 'Which repository?', tags: { topic: '' } }, undefined, undefined, ctx);
    assert.deepEqual((await card('tagged-2'))?.tags, { repo: 'acme/store' });
  });

  it('keeps the tags in the inbox, so a new session that was not launched with them still inherits them', async () => {
    // A restart of this session is a new process with the same agent id, and the inbox still has the defaults.
    delete process.env['YOUR_ATTENTION_TAGS'];
    const again = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => 'pi-tags-1' } };
    await handlers.get('session_start')?.({}, again);
    assert.equal((await card('tagged-2'))?.tags?.['repo'], 'acme/store');
    assert.deepEqual(Object.keys(await defaults('pi:pi-tags-1')).sort(), ['repo', 'topic']);
  });
});
