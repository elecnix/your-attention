// Runs the Claude Code channel as Claude Code does: an MCP server over stdio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_GUIDANCE, DEFAULT_GUIDANCE_VERSION } from '../../src/core/inbox.ts';
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
    assert.deepEqual(tools.map((t) => t.name).sort(), ['card_close', 'card_guidance', 'card_patch', 'card_post', 'card_read', 'card_search', 'card_status', 'card_tag', 'card_tags', 'card_template_save', 'card_triage_feedback', 'card_widget_save', 'settings']);
  });

  it('tells the session that its AskUserQuestion also becomes a card, and triage may send a weak one back', () => {
    const instructions = mcp.getInstructions() ?? '';
    assert.match(instructions, /An AskUserQuestion you ask also becomes a card in that inbox, and triage may send a weak one back before the person sees it/);
    assert.match(instructions, /state the goal, the options you weighed, and your recommendation, and ask again if it comes back/);
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

  it('ends the stretch of inactivity when the person sends the session a card, since that turn may post one back', async () => {
    // The Stop hook keeps the stretch in a file, and the channel times its asks for a card from it.
    const asks = path.join(h.home, 'claude', `${SESSION}.card-ask`);
    fs.mkdirSync(path.dirname(asks), { recursive: true });
    fs.writeFileSync(asks, JSON.stringify({ since: Date.now(), asks: 3 }));
    const res = await h.owner('POST', '/v1/send', { agent: `claude:${SESSION}`, text: 'Post the deploy card before you carry on.' });
    assert.equal(res.status, 201);
    const note = await until(() => notes.find((n) => n.content.includes('sent this session a card')));
    // The note asks for a reply card, which is the card the reset budget lets this session post.
    assert.match(note.content, /Post the deploy card before you carry on\./);
    assert.equal(fs.existsSync(asks), false, 'a sent card starts a turn, as an answer does, so the stretch ends');
  });

  it('closes its own card', async () => {
    await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-2', title: 'Still needed?', text: 'A card.' } });
    await mcp.callTool({ name: 'card_close', arguments: { card_id: 'cc-2', kind: 'self-answered', outcome: 'Found it in the README.' } });
    const s = (await h.stored()) as { states: Record<string, string> };
    assert.equal(s.states['cc-2'], 'closed');
  });

  it('asks for a secret with the secret widget, and hands the model a file path, never the value', async () => {
    const res = await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-key', title: 'Need the demo key', text: 'To set the CI secret.', body: 'root = Card([key])\nkey = widget secret {"name": "DEMO_API_KEY"}' } });
    assert.match(JSON.stringify(res.content), /Posted card cc-key\..*names a file for each secret/);
    const id = 'cc-key';
    const card = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === id);
    assert.deepEqual(card?.secrets, ['DEMO_API_KEY']);
    const publicKey = JSON.parse(JSON.parse(/SecretInput\("DEMO_API_KEY", ("(?:[^"\\]|\\.)*")\)/.exec(card!.body!)![1]!)) as JsonWebKey;
    await h.owner('POST', `/v1/cards/${id}/answer`, { values: { DEMO_API_KEY: await seal(publicKey, 'demo-value-not-real') } });
    const note = await until(() => notes.find((n) => n.meta.card_id === id));
    assert.doesNotMatch(note.content, /demo-value-not-real/);
    assert.match(note.content, /DEMO_API_KEY: \(sealed\)/);
    const file = /It is in (\S+), which/.exec(note.content)?.[1];
    assert.ok(file, note.content);
    assert.equal(fs.readFileSync(file, 'utf8'), 'demo-value-not-real');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('saves a pasted image to a private file and names its path in the event', async () => {
    await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-img', title: 'Which layout?', text: 'A card.' } });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await h.owner('POST', '/v1/cards/cc-img/answer', { values: {}, comment: 'like this', images: [{ src: png, name: 'mock.png', field: 'comment' }] });
    const note = await until(() => notes.find((n) => n.meta.card_id === 'cc-img'));
    const file = /Image pasted in comment: (\S+)/.exec(note.content)?.[1];
    assert.ok(file, note.content);
    assert.equal(fs.readFileSync(file).length, 70);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('answers a call to the removed card_ask_secret with the widget that replaces it', async () => {
    const res = await mcp.callTool({ name: 'card_ask_secret', arguments: { name: 'K', title: 'Key?' } });
    assert.match(JSON.stringify(res.content), /card_ask_secret was removed.*widget secret/);
  });

  it('searches earlier answers', async () => {
    const res = await mcp.callTool({ name: 'card_search', arguments: { query: 'agreed' } });
    assert.match(JSON.stringify(res.content), /cc-1/);
  });

  it('lists cards by a filter, with each result carrying its state, tags, agent and times', async () => {
    await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-filter-open', title: 'Still waiting?', text: 'A card.', tags: { repo: 'search-test' } } });
    await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-filter-done', title: 'Settled?', text: 'A card.', tags: { repo: 'search-test' } } });
    await h.owner('POST', '/v1/cards/cc-filter-done/answer', { values: {} });
    type Row = { id: string; state: string; tags: Record<string, string>; agent: string; posted: string; updated: string };
    const reply = async (args: Record<string, unknown>): Promise<{ results: Row[]; next_cursor?: string }> => {
      const res = await mcp.callTool({ name: 'card_search', arguments: args });
      return JSON.parse((res.content as { type: string; text: string }[])[0]?.text ?? '{}') as { results: Row[] };
    };
    const open = await reply({ state: 'open', tags: ['repo=search-test'] });
    assert.deepEqual(open.results.map((r) => r.id), ['cc-filter-open']);
    assert.equal(open.results[0]?.state, 'open');
    assert.deepEqual(open.results[0]?.tags, { repo: 'search-test' });
    assert.equal(open.results[0]?.agent, `claude:${SESSION}`);
    assert.ok(open.results[0]?.posted && open.results[0]?.updated, 'each result says when the card was posted and last changed');
    // A filter lifts the tool's default of answered cards, so no query and no state lists both.
    const both = await reply({ tags: ['repo=search-test'] });
    const states = Object.fromEntries(both.results.map((r) => [r.id, r.state]));
    assert.equal(states['cc-filter-open'], 'open');
    assert.ok(['answered', 'delivered', 'read'].includes(states['cc-filter-done'] ?? ''), `the answered card comes back too, and reads as ${states['cc-filter-done']}`);
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
    assert.match(JSON.stringify((await mcp.callTool({ name: 'card_guidance', arguments: {} })).content), new RegExp(`version ${DEFAULT_GUIDANCE_VERSION}`));
    assert.match(JSON.stringify((await mcp.callTool({ name: 'card_widget_save', arguments: { name: 'pr', source: 'root = Card([head])\nhead = CardHeader({{title}}, {{repo}})' } })).content), /widget pr version 1/);
    await mcp.callTool({ name: 'card_post', arguments: { id: 'cc-widget', title: 'Merge it?', body: 'root = Card([one])\none = widget pr {"title": "Add stop", "repo": "your-attention"}' } });
    const placed = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === 'cc-widget');
    assert.match(placed?.body ?? '', /one_head = CardHeader\("Add stop", "your-attention"\)/);
    const after = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === 'cc-files');
    assert.equal(after?.text, 'Draft two');
    assert.equal(after?.status, 'drafting');
  });

  it('tells the session about guidance the person approved', async () => {
    const first = DEFAULT_GUIDANCE.split('\n')[0]!;
    const proposed = await mcp.callTool({ name: 'card_guidance', arguments: { edits: [{ old: first, new: `${first}\nAttach a screenshot to every UI card.` }], message: 'Adds the screenshot rule.' } });
    const id = /card (\S+)\./.exec(JSON.stringify(proposed.content))?.[1];
    await h.owner('POST', `/v1/cards/${id}/answer`, { values: { choice: 'approve' } });
    const note = await until(() => notes.find((n) => n.content.includes('Attach a screenshot')));
    // One past the default text's own version, which is the version this approval replaces.
    assert.match(note.content, new RegExp(`version ${DEFAULT_GUIDANCE_VERSION + 1}`));
  });
});
