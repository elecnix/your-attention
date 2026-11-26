// A session that starts while its inbox is stopped: each integration completes its own start, answers a tool call with
// why it cannot reach the inbox, and connects once the inbox starts, with no restart of the session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { NO_INBOX } from '../../src/client.ts';
import { createPlugin } from '../../src/integrations/opencode/plugin.ts';
import yourAttention from '../../src/integrations/pi/extension.ts';
import { serve, type RunningServer } from '../../src/node/server.ts';
import { ROOT, until } from './harness.ts';

/** Start the inbox in `home`, as `your-attention serve` does: it writes server.json and the agent token there. */
const serveIn = (home: string): Promise<RunningServer> =>
  serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report', blocked: 'a test inbox sends nothing' } });
const online = (server: RunningServer, agent: string): true | undefined => server.inbox.state().presence[agent]?.online || undefined;

/** The home where one session starts before its inbox, and the way the test lets it go. */
function laterHome(): { open: (prefix: string) => string; close: (server: RunningServer | undefined, dispose?: () => unknown) => Promise<void> } {
  let home = '';
  return {
    open(prefix) {
      home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      process.env['YOUR_ATTENTION_HOME'] = home;
      return home;
    },
    async close(server, dispose) {
      await dispose?.();
      delete process.env['YOUR_ATTENTION_HOME'];
      await server?.close();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const savedPane = process.env['HERDR_PANE_ID'];
delete process.env['HERDR_PANE_ID'];
after(() => { if (savedPane !== undefined) process.env['HERDR_PANE_ID'] = savedPane; });

describe('the Claude Code channel, started before its inbox', () => {
  let home = '';
  let mcp: McpClient;
  let server: RunningServer | undefined;
  const later = laterHome();
  before(async () => {
    home = later.open('ya-later-');
    mcp = new McpClient({ name: 'test', version: '1' });
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-channel'],
      env: { ...process.env, YOUR_ATTENTION_HOME: home, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'later-1', HERDR_PANE_ID: '', YOUR_ATTENTION_URL: '', YOUR_ATTENTION_TOKEN: '' } as Record<string, string>,
      stderr: 'ignore',
    }));
  });
  after(async () => { await later.close(server, () => mcp.close()); });

  it('completes the handshake and offers the card tools while no inbox runs', async () => {
    assert.equal(fs.existsSync(path.join(home, 'server.json')), false);
    const { tools } = await mcp.listTools();
    assert.ok(tools.some((t) => t.name === 'card_post'));
  });

  it('answers a tool call with an error that says the inbox is not running and the session connects when it starts', async () => {
    const res = await mcp.callTool({ name: 'card_post', arguments: { id: 'later-card', title: 'Ship it?', text: 'A card.' } });
    assert.equal(res.isError, true);
    assert.equal((res.content as { text: string }[])[0]?.text, NO_INBOX);
  });

  it('connects once the inbox writes server.json, and the inbox shows the agent online', async () => {
    server = await serveIn(home);
    await until(() => online(server!, 'claude:later-1'), 10_000);
    const res = await mcp.callTool({ name: 'card_post', arguments: { id: 'later-card', title: 'Ship it?', text: 'A card.' } });
    assert.match(JSON.stringify(res.content), /Posted card later-card/);
  });
});

describe('the pi extension, started before its inbox', () => {
  let home = '';
  let server: RunningServer | undefined;
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => 'pi-later-1', getCwd: () => '/repo', getSessionName: () => 'later' } };
  const pi = {
    on: (name: string, fn: Handler) => { handlers.set(name, fn); },
    registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }) => { tools.set(t.name, t); },
    sendUserMessage: () => {},
  };
  const later = laterHome();
  before(() => { home = later.open('ya-later-pi-'); });
  after(async () => { await later.close(server, () => handlers.get('session_shutdown')?.({}, ctx)); });

  it('starts the session, answers a tool call with why it cannot reach the inbox, and connects once the inbox starts', async () => {
    yourAttention(pi as never);
    await handlers.get('session_start')?.({}, ctx);
    await assert.rejects(tools.get('card_post')!.execute('c1', { id: 'pi-later', title: 'Ship it?', text: 'A card.' }, undefined, undefined, ctx), { message: NO_INBOX });
    server = await serveIn(home);
    await until(() => online(server!, 'pi:pi-later-1'), 10_000);
    const res = await tools.get('card_post')!.execute('c2', { id: 'pi-later', title: 'Ship it?', text: 'A card.' }, undefined, undefined, ctx);
    assert.match(res.content[0]!.text, /Posted card pi-later/);
  });
});

describe('the OpenCode plugin, started before its inbox', () => {
  let home = '';
  let server: RunningServer | undefined;
  let hooks: Awaited<ReturnType<ReturnType<typeof createPlugin>>> | undefined;
  const client = { session: { promptAsync: async () => ({}), get: async () => ({ data: { title: 'later' } }) } };
  const toolCtx = { sessionID: 'oc-later-1', directory: '/repo' };
  const later = laterHome();
  before(() => { home = later.open('ya-later-oc-'); });
  after(async () => { await later.close(server, () => hooks?.dispose?.()); });

  it('gives OpenCode the card tools, answers a call with why it cannot reach the inbox, and posts once the inbox starts', async () => {
    hooks = await createPlugin(z)({ client, directory: '/repo' } as never);
    const post = hooks.tool?.['card_post'];
    assert.ok(post, 'the plugin offers card_post while no inbox runs');
    await assert.rejects(post.execute({ id: 'oc-later', title: 'Ship it?', text: 'A card.' }, toolCtx), { message: NO_INBOX });
    server = await serveIn(home);
    const posted = await until(async () => {
      try { return await post.execute({ id: 'oc-later', title: 'Ship it?', text: 'A card.' }, toolCtx); } catch { return undefined; }
    }, 10_000);
    assert.match(posted, /Posted card oc-later/);
    // The tool call follows its session, so the inbox shows the agent online.
    await until(() => online(server!, 'opencode:oc-later-1'), 10_000);
  });
});
