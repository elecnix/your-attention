// The channel does not hand an answer to a session that cannot receive it. It holds every push until the
// client has finished connecting, pushes once more when the transcript never shows the receipt, and then
// types the answer into the session's own herdr pane or says on the card that the agent did not see it.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { Card } from '../../src/core/types.ts';
import { ROOT, callAt, start, until, type Harness } from './harness.ts';

const CLI = path.join(ROOT, 'src/cli.ts');
const CHANNEL_ARGS = ['--disable-warning=ExperimentalWarning', CLI, 'claude-channel'];
const FLAG = '--dangerously-load-development-channels=server:your-attention';
// A 60 second wait does not fit a test, so the channel reads its retry window from the environment.
const RETRY_MS = 300;
// herdr and ps are POSIX tools, and the fake herdr below is a shell script. Windows runs neither path.
const posixOnly = process.platform === 'win32' ? 'herdr and ps are POSIX tools' : false;

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

/** The environment a channel in this home needs, without the herdr session that runs the tests. */
function envFor(extra: Record<string, string>): Record<string, string> {
  const env = { ...process.env, YOUR_ATTENTION_HOME: h.home, HOME: h.home, USERPROFILE: h.home, YOUR_ATTENTION_CHANNEL_RETRY_MS: String(RETRY_MS) } as Record<string, string>;
  for (const k of Object.keys(env)) if (k.startsWith('HERDR_')) delete env[k];
  delete env['YOUR_ATTENTION_URL'];
  delete env['YOUR_ATTENTION_TOKEN'];
  return { ...env, ...extra };
}

/** A herdr that records each command, answers for one pane, and shows `box` as its input box. */
function fakeHerdr(box: string): { bin: string; text(): string; calls(): string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-channel-herdr-'));
  const log = path.join(dir, 'calls');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'herdr'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  'pane current') printf '%s' '{"result":{"pane":{"pane_id":"w7:p1","tab_id":"w7:t1","workspace_id":"w7"}}}' ;;
  'tab get') printf '%s' '{"result":{"tab":{"tab_id":"w7:t1","label":"retry test"}}}' ;;
  'workspace get') printf '%s' '{"result":{"workspace":{"workspace_id":"w7","label":"Tests"}}}' ;;
  'pane get') printf '%s' '{"result":{"pane":{"pane_id":"w7:p1","agent":"claude","terminal_title_stripped":"retry test"}}}' ;;
  'pane read') printf 'earlier output in the session\\n❯ ${box}\\n' ;;
esac
exit 0
`, { mode: 0o755 });
  const text = () => fs.readFileSync(log, 'utf8');
  return { bin: path.join(dir, 'herdr'), text, calls: () => text().split('\n').filter(Boolean) };
}

/** Connect to a channel, and wait until the inbox reports its agent online. */
async function connectChannel(session: string, command: string, args: string[]): Promise<McpClient> {
  const mcp = new McpClient({ name: 'test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command, args, env: envFor({ CLAUDE_CODE_SESSION_ID: session }), stderr: 'ignore' }));
  await until(async () => ((await h.stored()) as { presence: Record<string, { online: boolean }> }).presence[`claude:${session}`]?.online);
  return mcp;
}

/** A channel process the test speaks MCP to itself, so it can answer a card before the client connects. */
function rawChannel(env: Record<string, string>) {
  const child: ChildProcess = spawn(process.execPath, CHANNEL_ARGS, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', () => {});
  const notes: { content: string; meta: { card_id: string; receipt: string } }[] = [];
  const replies: Record<string, unknown>[] = [];
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line) as { id?: string; method?: string; result?: unknown; params?: unknown };
        if (msg.method === 'notifications/claude/channel') notes.push(msg.params as (typeof notes)[number]);
        else if (msg.id !== undefined) replies.push(msg);
      } catch { /* a line that is not a message */ }
    }
  });
  return {
    notes,
    replies,
    send: (msg: unknown) => child.stdin?.write(`${JSON.stringify(msg)}\n`),
    stop: () => child.kill(),
  };
}

describe('the channel while a session cannot receive an answer', () => {
  it('pushes again after a quiet retry window, then types the answer into the session pane', { skip: posixOnly }, async () => {
    const SESSION = 'retry-session-1';
    const herdr = fakeHerdr('');
    const mcp = new McpClient({ name: 'test', version: '1' });
    const notes: { content: string; meta: { card_id: string; receipt: string } }[] = [];
    mcp.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/claude/channel') notes.push(n.params as (typeof notes)[number]);
    };
    const transcript = path.join(h.home, '.claude', 'projects', '-repo', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"start"}\n');
    try {
      await mcp.connect(new StdioClientTransport({
        command: process.execPath,
        args: CHANNEL_ARGS,
        env: envFor({ CLAUDE_CODE_SESSION_ID: SESSION, HERDR_PANE_ID: 'w7:p1', HERDR_BIN_PATH: herdr.bin }),
        stderr: 'ignore',
      }));
      // A tool call is the first request after the handshake, which is where Claude Code registers channels.
      await mcp.listTools();
      await mcp.callTool({ name: 'card_post', arguments: { id: 'retry-1', title: 'Ship it?', options: ['Yes'] } });
      await h.owner('POST', '/v1/cards/retry-1/answer', { values: { choice: 'o1' }, comment: 'ship the retry' });
      // The transcript never changes, so the receipt cannot appear in it.
      await until(() => notes.filter((n) => n.meta.card_id === 'retry-1').length === 1);
      await until(() => notes.filter((n) => n.meta.card_id === 'retry-1').length === 2);
      const typed = await until(() => (/agent prompt w7:p1 [\s\S]*ship the retry/.test(herdr.text()) ? herdr.text() : undefined));
      assert.match(typed, /The person answered card "Ship it\?"/);
      assert.ok(!herdr.calls().some((l) => /agent prompt w7:p\d+/.test(l) && !l.includes('w7:p1')), 'the answer goes to this session\'s pane only');
      // The session now has the answer as its own prompt, so the card reads as read.
      await until(async () => (await h.stored()).states['retry-1'] === 'read');
    } finally {
      await mcp.close();
    }
  });

  it('delivers the answer the person saved last, not the one it replaced', { skip: posixOnly }, async () => {
    const SESSION = 'retry-session-3';
    const herdr = fakeHerdr('');
    const mcp = new McpClient({ name: 'test', version: '1' });
    try {
      await mcp.connect(new StdioClientTransport({
        command: process.execPath,
        args: CHANNEL_ARGS,
        env: envFor({ CLAUDE_CODE_SESSION_ID: SESSION, HERDR_PANE_ID: 'w7:p1', HERDR_BIN_PATH: herdr.bin }),
        stderr: 'ignore',
      }));
      await mcp.listTools();
      await mcp.callTool({ name: 'card_post', arguments: { id: 'retry-3', title: 'Ship it?', options: ['Yes'] } });
      await h.owner('POST', '/v1/cards/retry-3/answer', { comment: 'the first thought' });
      await h.owner('POST', '/v1/cards/retry-3/answer', { comment: 'the second thought' });
      await until(() => (/agent prompt w7:p1 [\s\S]*the second thought/.test(herdr.text()) ? true : undefined));
      assert.doesNotMatch(herdr.text(), /the first thought/);
    } finally {
      await mcp.close();
    }
  });

  it('leaves the answer delivered and says on the card why the agent did not see it, when the pane holds a draft', { skip: posixOnly }, async () => {
    const SESSION = 'retry-session-2';
    const herdr = fakeHerdr('my own half-written message');
    const mcp = new McpClient({ name: 'test', version: '1' });
    try {
      await mcp.connect(new StdioClientTransport({
        command: process.execPath,
        args: CHANNEL_ARGS,
        env: envFor({ CLAUDE_CODE_SESSION_ID: SESSION, HERDR_PANE_ID: 'w7:p1', HERDR_BIN_PATH: herdr.bin }),
        stderr: 'ignore',
      }));
      await mcp.listTools();
      await mcp.callTool({ name: 'card_post', arguments: { id: 'retry-2', title: 'Ship it?', options: ['Yes'] } });
      await h.owner('POST', '/v1/cards/retry-2/answer', { comment: 'not while you are typing' });
      const card = await until(async () => {
        const c = ((await h.stored()) as { cards: Card[] }).cards.find((x) => x.id === 'retry-2');
        return c?.status?.startsWith('Not seen by the agent') ? c : undefined;
      });
      assert.equal(card.status, 'Not seen by the agent: the pane holds a draft');
      assert.equal(((await h.stored()) as { states: Record<string, string> }).states['retry-2'], 'delivered');
      assert.ok(!herdr.calls().some((l) => l.startsWith('agent prompt')), 'nothing is typed over the person\'s draft');
    } finally {
      await mcp.close();
    }
  });
});

describe('the channel at startup', () => {
  it('holds an answer until the client has finished connecting', async () => {
    const SESSION = 'startup-session-1';
    const agent = `claude:${SESSION}`;
    const channel = rawChannel(envFor({ CLAUDE_CODE_SESSION_ID: SESSION }));
    try {
      await until(async () => ((await h.stored()) as { presence: Record<string, { online: boolean }> }).presence[agent]?.online);
      // The card belongs to the channel's own token, which is the inbox's agent token.
      const posted = await callAt(h.server.url, h.agentToken, 'POST', '/v1/cards', { id: 'startup-1', agent, title: 'Send now?' });
      assert.equal(posted.status, 201);
      await h.owner('POST', '/v1/cards/startup-1/answer', { comment: 'send after connecting' });
      await new Promise((r) => setTimeout(r, RETRY_MS * 2));
      assert.equal(channel.notes.length, 0, 'nothing goes out before the session has connected');

      channel.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
      await until(() => channel.replies.find((r) => r.id === 1));
      channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await new Promise((r) => setTimeout(r, RETRY_MS));
      assert.equal(channel.notes.length, 0, 'nothing goes out before the client asks for a tool, which is where it registers channels');

      channel.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const note = await until(() => channel.notes.find((n) => n.meta.card_id === 'startup-1'));
      assert.match(note.content, /send after connecting/);
    } finally {
      channel.stop();
    }
  });

  it('reports Channel off only for a session whose parent lacks the flag', { skip: posixOnly }, async () => {
    // A parent whose command line carries the flag, as Claude Code's does. ps reads the process title.
    const wrapper = path.join(h.home, 'claude-parent.mjs');
    fs.writeFileSync(wrapper, `import { spawn } from 'node:child_process';
process.title = 'claude ${FLAG}';
const [script] = process.argv.slice(2);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'claude-channel'], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
`);
    const presenceOf = async (session: string): Promise<{ channelOff?: boolean } | undefined> =>
      ((await h.stored()) as { presence: Record<string, { channelOff?: boolean }> }).presence[`claude:${session}`];
    const without = await connectChannel('startup-session-2', process.execPath, CHANNEL_ARGS);
    const flagged = await connectChannel('startup-session-3', process.execPath, [wrapper, CLI]);
    try {
      assert.equal((await presenceOf('startup-session-2'))?.channelOff, true);
      assert.equal((await presenceOf('startup-session-3'))?.channelOff, undefined);
    } finally {
      await without.close();
      await flagged.close();
    }
  });
});
