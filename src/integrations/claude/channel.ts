// The Claude Code channel: an MCP server that gives the session tools to post
// cards, and pushes each answer into the session the moment it is saved.
// The answer is marked read once it appears in the session transcript, which
// is where Claude Code records what the model receives.
// stdout carries the MCP protocol, so logs go to stderr.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client, describeAnswer, loadConfig } from '../../client.ts';
import { SecretRequests } from '../secrets.ts';
import { runTool } from '../run-tool.ts';
import { cardTools } from '../tools.ts';

const log = (...a: unknown[]): void => console.error('[your-attention]', ...a);
const config = loadConfig();
if (!config) {
  log('no inbox found: start one with `your-attention serve` or pair with `your-attention pair <url>`');
  process.exit(1);
}
const inbox = new Client(config);
const session = process.env['CLAUDE_CODE_SESSION_ID'] ?? `pid-${process.ppid}`;
const agent = `claude:${session}`;
const pane = process.env['HERDR_PANE_ID'];
const secrets = new SecretRequests();
const origin = { harness: 'claude-code', session, host: os.hostname(), cwd: process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd(), herdrPane: pane };

const mcp = new Server(
  { name: 'your-attention', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: [
      `Events from this channel are answers the person saved on cards in their inbox at ${inbox.url}.`,
      'Post a card with card_post when you need a decision from the person and can keep working meanwhile. Give a goal, the options you weighed, and your recommendation.',
      'Search past answers with card_search before you post, so you never ask twice.',
      'Each event carries card_id. Act on the answer. The person reads the inbox, not this chat.',
      'Call card_close to retract a card you no longer need or to answer it yourself. Read receipts are automatic.',
    ].join(' '),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cardTools.map(({ name, description, schema }) => ({ name, description, inputSchema: schema })) }));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const text = (t: unknown) => ({ content: [{ type: 'text' as const, text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
  try {
    return text(await runTool({ inbox, secrets, agent, origin, arrival: 'as a channel event' }, req.params.name, args));
  } catch (e) {
    return { ...text(String((e as Error).message)), isError: true };
  }
});

/** Dismiss the open AskUserQuestion dialog with Escape, in this session's own herdr pane only. */
function closeOwnDialog(cardPane: string | undefined): Promise<boolean> {
  if (!pane || cardPane !== pane) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(process.env['HERDR_BIN_PATH'] ?? 'herdr', ['agent', 'send-keys', pane, 'escape'], (err) => {
      if (err) { log('escape failed:', err.message); return resolve(false); }
      setTimeout(() => resolve(true), 400);
    });
  });
}

// Receipt id -> card id, for answers pushed but not yet seen in the transcript.
const pending = new Map<string, string>();
const transcriptDir = path.join(os.homedir(), '.claude', 'projects');
let transcript: string | undefined;
let offset = 0;

function findTranscript(): string | undefined {
  try {
    for (const dir of fs.readdirSync(transcriptDir)) {
      const f = path.join(transcriptDir, dir, `${session}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return undefined;
}

function scanTranscript(): void {
  if (!pending.size) return;
  transcript ??= findTranscript();
  if (!transcript) return;
  const size = fs.statSync(transcript).size;
  if (size <= offset) return;
  const fd = fs.openSync(transcript, 'r');
  const chunk = Buffer.alloc(size - offset);
  fs.readSync(fd, chunk, 0, chunk.length, offset);
  fs.closeSync(fd);
  offset = size;
  const added = chunk.toString('utf8');
  for (const [receipt, id] of pending) {
    if (!added.includes(receipt)) continue;
    pending.delete(receipt);
    inbox.ack(id).then(() => log('read', id), (e: Error) => log('ack failed:', e.message));
  }
}

const stop = new AbortController();
const quit = (): void => { stop.abort(); process.exit(0); };
// Exit with the session: a leftover server would show the agent as listening.
process.stdin.on('end', quit);
process.stdin.on('close', quit);
mcp.onclose = quit;

await mcp.connect(new StdioServerTransport());
transcript = findTranscript();
offset = transcript ? fs.statSync(transcript).size : 0;
setInterval(scanTranscript, 500);
log('connected to', inbox.url, 'as', agent);

void inbox.stream(agent, async (ev) => {
  if (ev.type === 'guidance') {
    await mcp.notification({ method: 'notifications/claude/channel', params: { content: `The person approved new card guidance, version ${ev.guidance.version}. Follow it from now on:\n${ev.guidance.text}`, meta: { guidance: String(ev.guidance.version) } } });
    return;
  }
  if (ev.type === 'returned') {
    await mcp.notification({ method: 'notifications/claude/channel', params: { content: `Triage sent back card ${ev.card.id} ("${ev.card.title}"): ${ev.reason} Revise it with card_patch or post a better card.`, meta: { card_id: ev.card.id } } });
    return;
  }
  if (ev.type !== 'answer') return;
  const { card, answer } = ev;
  const dismissed = card.questions ? await closeOwnDialog(card.origin?.herdrPane) : false;
  const receipt = ev.id;
  pending.set(receipt, card.id);
  const head = card.questions
    ? `The person answered your AskUserQuestion in the inbox. Treat this as their answer${dismissed ? ' and ignore the cancelled dialog' : ''}:`
    : `The person answered card "${card.title}":`;
  const urgency = answer.delivery === 'force' ? ' They force-sent it: act on it now.' : '';
  const body = card.kind === 'secret' ? await secrets.receive(card, answer) : `${head}${urgency}\n${describeAnswer(card, answer)}`;
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: body, meta: { card_id: card.id, receipt } },
  });
  log('pushed', card.id, receipt);
}, stop.signal);
