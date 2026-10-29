// Runs the Claude Code channel as Claude Code does: an MCP server over stdio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Card } from '../../src/core/types.ts';
import { seal } from '../../web/sealed.js';
import { ROOT, start, until, type Harness } from './harness.ts';

let h: Harness;
let mcp: McpClient;
const notes: { content: string; meta: { card_id: string; receipt: string } }[] = [];
const SESSION = 'test-session-1';

before(async () => {
  h = await start();
  mcp = new McpClient({ name: 'test', version: '1' });
  mcp.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') notes.push(n.params as (typeof notes)[number]);
  };
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-channel'],
    env: { ...process.env, YOUR_ATTENTION_HOME: h.home, HOME: h.home, USERPROFILE: h.home, CLAUDE_CODE_SESSION_ID: SESSION, HERDR_PANE_ID: '' } as Record<string, string>,
    stderr: 'ignore',
  }));
});
after(async () => {
  await mcp.close();
  await h.stop();
});

describe('the Claude Code channel', () => {
  it('offers the card tools', async () => {
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['card_ask_secret', 'card_close', 'card_guidance', 'card_patch', 'card_post', 'card_reply', 'card_search', 'card_status', 'card_template_save', 'card_widget_save']);
  });

  it('posts a card, pushes the answer into the session, and marks it read from the transcript', async () => {
    const transcript = path.join(h.home, '.claude', 'projects', '-repo', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"start"}\n');
    const res = await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-1', title: 'Use SQLite?', options: ['Yes', 'No'], recommendation: 'Yes: one file.' } });
    assert.match(JSON.stringify(res.content), /Posted card cc-1/);
    const state = async () => (await h.stored()) as { cards: Card[]; states: Record<string, string> };
    const card = (await state()).cards.find((c) => c.id === 'cc-1');
    assert.equal(card?.agent, `claude:${SESSION}`);
    assert.equal(card?.origin?.harness, 'claude-code');
    await until(async () => ((await h.stored()) as { presence: Record<string, { online: boolean }> }).presence[`claude:${SESSION}`]?.online);

    await h.owner('POST', '/v1/cards/cc-1/answer', { values: { choice: 'o1' }, comment: 'agreed' });
    const note = await until(() => notes.find((n) => n.meta.card_id === 'cc-1'));
    assert.match(note.content, /choice: Yes\nComment: agreed/);
    assert.equal((await state()).states['cc-1'], 'delivered');

    // Claude Code writes the event into the transcript when the model receives it.
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', receipt: note.meta.receipt })}\n`);
    await until(async () => (await state()).states['cc-1'] === 'read' || undefined);
  });

  it('closes its own card', async () => {
    await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-2', title: 'Still needed?' } });
    await mcp.callTool({ name: 'card_close', arguments: { card_id: 'cc-2', kind: 'self-answered', outcome: 'Found it in the README.' } });
    const s = (await h.stored()) as { states: Record<string, string> };
    assert.equal(s.states['cc-2'], 'closed');
  });

  it('asks for a secret, and hands the model a file path, never the value', async () => {
    const res = await mcp.callTool({ name: 'card_ask_secret', arguments: { name: 'DEMO_API_KEY', title: 'Need the demo key', text: 'To set the CI secret.' } });
    const id = /card (\S+)\./.exec(JSON.stringify(res.content))?.[1];
    assert.ok(id);
    const card = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === id);
    assert.equal(card?.kind, 'secret');
    const sealed = await seal(card!.secret!.publicKey, 'demo-value-not-real');
    await h.owner('POST', `/v1/cards/${id}/answer`, { values: { sealed } });
    const note = await until(() => notes.find((n) => n.meta.card_id === id));
    assert.doesNotMatch(note.content, /demo-value-not-real/);
    const file = /It is in (\S+), which/.exec(note.content)?.[1];
    assert.ok(file, note.content);
    assert.equal(fs.readFileSync(file, 'utf8'), 'demo-value-not-real');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('searches earlier answers', async () => {
    const res = await mcp.callTool({ name: 'card_search', arguments: { query: 'agreed' } });
    assert.match(JSON.stringify(res.content), /cc-1/);
  });
});

describe('the batch of card model tools', () => {
  it('posts a card with a local file, patches it, labels it, and saves a template', async () => {
    const file = path.join(h.home, 'plan.md');
    fs.writeFileSync(file, '# Plan\n\n- ship the bridge');
    const res = await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-files', title: 'Read the plan', text: 'Draft one', attachments: [{ path: file }] } });
    assert.match(JSON.stringify(res.content), /Posted card cc-files/);
    const s = (await h.stored()) as { cards: Card[] };
    const card = s.cards.find((c) => c.id === 'cc-files');
    assert.equal(card?.attachments?.[0]?.name, 'plan.md');
    assert.equal(card?.attachments?.[0]?.type, 'text/markdown');
    const bytes = await (await h.owner('GET', `/v1/attachments/${card!.attachments![0]!.id}`)).text();
    assert.equal(bytes, '# Plan\n\n- ship the bridge');
    assert.match(JSON.stringify((await mcp.callTool({ name: 'card_patch', arguments: { card_id: 'cc-files', edits: [{ old: 'one', new: 'two' }] } })).content), /version 2/);
    await mcp.callTool({ name: 'card_status', arguments: { card_id: 'cc-files', status: 'drafting' } });
    assert.match(JSON.stringify((await mcp.callTool({ name: 'card_template_save', arguments: { name: 'plan', source: 'root = Card([TextContent({{x}})])' } })).content), /version 1/);
    assert.match(JSON.stringify((await mcp.callTool({ name: 'card_guidance', arguments: {} })).content), /version 1/);
    assert.match(JSON.stringify((await mcp.callTool({ name: 'card_widget_save', arguments: { name: 'pr', source: 'root = Card([head])\nhead = CardHeader({{title}}, {{repo}})' } })).content), /widget pr version 1/);
    await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-widget', title: 'Merge it?', body: 'root = Card([one])\none = widget pr {"title": "Add stop", "repo": "your-attention"}' } });
    const placed = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === 'cc-widget');
    assert.match(placed?.body ?? '', /one_head = CardHeader\("Add stop", "your-attention"\)/);
    const after = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === 'cc-files');
    assert.equal(after?.text, 'Draft two');
    assert.equal(after?.status, 'drafting');
  });

  it('tells the session about guidance the person approved', async () => {
    const proposed = await mcp.callTool({ name: 'card_guidance', arguments: { propose: 'Attach a screenshot to every UI card.' } });
    const id = /card (\S+)\./.exec(JSON.stringify(proposed.content))?.[1];
    await h.owner('POST', `/v1/cards/${id}/answer`, { values: { choice: 'approve' } });
    const note = await until(() => notes.find((n) => n.content.includes('Attach a screenshot')));
    assert.match(note.content, /version 2/);
  });
});
