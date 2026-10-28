// Loads the OpenCode plugin against a stand-in for OpenCode's plugin input, with the real Zod OpenCode hands plugins.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';
import { Client } from '../../src/client.ts';
import { createPlugin, toolArgs } from '../../src/integrations/opencode/plugin.ts';
import { cardTools } from '../../src/integrations/tools.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => {
  h = await start();
  process.env['YOUR_ATTENTION_HOME'] = h.home;
});
after(async () => {
  await hooks?.dispose?.();
  delete process.env['YOUR_ATTENTION_HOME'];
  await h.stop();
});

type Hooks = Awaited<ReturnType<ReturnType<typeof createPlugin>>>;
let hooks: Hooks;
const prompts: { id: string; text: string }[] = [];
const client = {
  session: {
    promptAsync: async ({ path, body }: { path: { id: string }; body: { parts: { type: string; text: string }[] } }) => {
      prompts.push({ id: path.id, text: body.parts.map((p) => p.text).join('') });
      return { response: { status: 204 } };
    },
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, title: 'Release prep' } }),
  },
};
const toolCtx = (sessionID: string) => ({ sessionID, messageID: 'm1', agent: 'build', directory: '/repo', worktree: '/repo', abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });
const state = async () => (await (await h.owner('GET', '/v1/state')).json()) as { states: Record<string, string>; cards: { id: string; agent: string; origin?: Record<string, string> }[] };

describe('the OpenCode plugin', () => {
  it('turns each card tool schema into Zod arguments, with only the required ones required', () => {
    const post = cardTools.find((t) => t.name === 'card_post')!;
    const args = z.object(toolArgs(z, post.schema));
    assert.equal(args.safeParse({ title: 'Ship it?' }).success, true);
    assert.equal(args.safeParse({}).success, false);
    assert.equal(args.safeParse({ title: 'q', priority: 'whenever' }).success, false);
    assert.equal(args.safeParse({ title: 'q', options: ['Yes', 'No'], tags: { topic: 'release' }, attachments: [{ path: '/tmp/a.png' }] }).success, true);
    for (const t of cardTools) assert.doesNotThrow(() => z.toJSONSchema(z.object(toolArgs(z, t.schema))), t.name);
  });

  it('gives OpenCode every card tool', async () => {
    hooks = await createPlugin(z)({ client, directory: '/repo', worktree: '/repo' } as never);
    assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), cardTools.map((t) => t.name).sort());
  });

  it('posts a card for the session that called the tool, named after the session', async () => {
    const out = await hooks.tool!['card_post']!.execute({ id: 'oc-1', title: 'Ship on Friday?', options: ['Yes', 'No'] }, toolCtx('ses_1') as never);
    assert.match(String(out), /Posted card oc-1/);
    const card = (await state()).cards.find((c) => c.id === 'oc-1')!;
    assert.equal(card.agent, 'opencode:ses_1');
    assert.deepEqual({ harness: card.origin?.['harness'], session: card.origin?.['session'], cwd: card.origin?.['cwd'], name: card.origin?.['name'] }, { harness: 'opencode', session: 'ses_1', cwd: '/repo', name: 'Release prep' });
  });

  it('sends the answer into that session as a new message, and marks it read once it reaches the conversation', async () => {
    await h.owner('POST', '/v1/cards/oc-1/answer', { values: { choice: 'o2' }, comment: 'after the freeze' });
    const msg = await until(() => prompts.find((p) => p.text.includes('oc-1')));
    assert.equal(msg.id, 'ses_1');
    assert.match(msg.text, /choice: No/);
    assert.match(msg.text, /after the freeze/);
    assert.notEqual((await state()).states['oc-1'], 'read');
    await hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {} as never, parts: [{ type: 'text', text: msg.text }] as never });
    await until(async () => (await state()).states['oc-1'] === 'read' || undefined);
  });

  it('follows a session it sees in an event when that session has an open card', async () => {
    await new Client({ url: h.server.url, token: h.agentToken }).post({ id: 'oc-2', agent: 'opencode:ses_2', title: 'From before a restart' });
    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'idle' } } } as never });
    await h.owner('POST', '/v1/cards/oc-2/answer', { values: {}, comment: 'still yes' });
    const msg = await until(() => prompts.find((p) => p.text.includes('oc-2')));
    assert.equal(msg.id, 'ses_2');
  });
});

describe('your-attention opencode-plugin', () => {
  it('writes a file in OpenCode plugin directory that loads this checkout', async () => {
    const { pluginFile, pluginSource } = await import('../../src/integrations/opencode/install.ts');
    assert.equal(pluginFile({ XDG_CONFIG_HOME: '/cfg' }), '/cfg/opencode/plugin/your-attention.ts');
    const src = pluginSource();
    assert.match(src, /from '@opencode-ai\/plugin'/);
    assert.match(src, /src\/integrations\/opencode\/plugin\.ts"/);
    assert.match(src, /export const YourAttention = createPlugin\(tool\.schema\)/);
    assert.match(pluginSource('C:\\ya\\src\\integrations\\opencode\\plugin.ts', 'win32'), /from "file:\/\/\/C:\/ya\/src\/integrations\/opencode\/plugin\.ts"/);
  });
});
