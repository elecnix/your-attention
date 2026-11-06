// The Claude Code channel: an MCP server that gives the session tools to post
// cards, and pushes each answer into the session the moment it is saved.
// The answer is marked read once it appears in the session transcript, which
// is where Claude Code records what the model receives. A push that the
// transcript never shows is sent once more, and then typed into the session's
// own herdr pane, so an answer is never left waiting unnoticed.
// stdout carries the MCP protocol, so logs go to stderr.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client, describeAnswer, describeReturned, loadConfig } from '../../client.ts';
import { saveAnswerImages } from '../images.ts';
import { SecretRequests } from '../secrets.ts';
import { runTool } from '../run-tool.ts';
import { claudeSessionName } from './session-name.ts';
import { devChannelEnabled, parentArgs } from './channel-flag.ts';
import { boxState, runHerdr } from '../herdr/approve.ts';
import { herdrPlace } from '../herdr/place.ts';
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
// Claude Code discards every channel notification of a session started without the flag, so the inbox shows
// that this session cannot receive an answer. An unreadable command line claims nothing.
const channelOff = devChannelEnabled(parentArgs(process.ppid)) === false;
/** How long a pushed answer waits in the transcript before the channel sends it again. */
const retryMs = Number(process.env['YOUR_ATTENTION_CHANNEL_RETRY_MS']);
const RETRY_MS = retryMs > 0 ? retryMs : 60_000;/** A client that never asks for a tool still gets its answers, so a push waits for registration at most this long. */
const REGISTER_WAIT_MS = 30_000;

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

// Claude Code registers channel notifications just after it finishes connecting, and drops anything pushed
// before that, including the answers a resumed session waited for. So a push waits for the client's first
// request after the initialized notification, which is a tool call it can only make once it is connected.
let initialized = false;
let registered!: () => void;
const connected = new Promise<void>((resolve) => { registered = resolve; });
mcp.oninitialized = () => { initialized = true; };
const clientReady = (): void => { if (initialized) registered(); };
const registerTimer = setTimeout(registered, REGISTER_WAIT_MS);
registerTimer.unref();

async function notify(content: string, meta: Record<string, string>): Promise<void> {
  await connected;
  await mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } });
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  clientReady();
  return { tools: cardTools.map(({ name, description, schema }) => ({ name, description, inputSchema: schema })) };
});
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  clientReady();
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const text = (t: unknown) => ({ content: [{ type: 'text' as const, text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
  try {
    // Read the name at each call: Claude Code titles a session after its first prompts, and the person can rename it.
    const place = async () => ({ ...origin, name: claudeSessionName(session), ...(await herdrPlace(pane)) });
    return text(await runTool({ inbox, secrets, agent, origin: place, arrival: 'as a channel event' }, req.params.name, args));
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

/** An answer the session has not shown in its transcript, and what the channel has left to try. */
interface Push {
  card: string;
  body: string;
  meta: { card_id: string; receipt: string };
  /** When this push went out, or when the transcript last grew after it. The retry waits for this to age. */
  at: number;
  /** A push that is still waiting for the client to finish connecting, so the retry leaves it alone. */
  pushing: boolean;
  /** 1 after the first push, 2 after the second. */
  pushes: number;
}

// Receipt id -> the answer pushed but not yet seen in the transcript.
const pending = new Map<string, Push>();
/** Cards whose page says the agent did not see the answer, with the label this channel put there. */
const notSeen = new Map<string, string>();
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

function transcriptSize(): number {
  if (!transcript) return 0;
  try { return fs.statSync(transcript).size; } catch { return 0; }
}

function scanTranscript(): void {
  if (!pending.size) return;
  transcript ??= findTranscript();
  try {
    const size = transcriptSize();
    if (transcript && size > offset) {
      const fd = fs.openSync(transcript, 'r');
      const chunk = Buffer.alloc(size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      fs.closeSync(fd);
      offset = size;
      const added = chunk.toString('utf8');
      for (const [receipt, push] of pending) {
        // The session wrote something and this receipt was not in it: it is at work, so the retry waits.
        if (!added.includes(receipt)) { push.at = Date.now(); continue; }
        pending.delete(receipt);
        inbox.ack(push.card).then(() => { log('read', push.card); void clearNotSeen(push.card); }, (e: Error) => log('ack failed:', e.message));
      }
    }
  } catch (e) {
    log('transcript read failed:', (e as Error).message);
  }
  const now = Date.now();
  for (const [receipt, push] of [...pending]) {
    if (push.pushing || now - push.at < RETRY_MS) continue;
    if (push.pushes === 1) void pushAgain(receipt, push);
    else void fallback(receipt, push);
  }
}

async function pushAgain(receipt: string, push: Push): Promise<void> {
  push.pushing = true;
  const sent = await notify(push.body, push.meta).then(() => true, (e: Error) => { log('second push failed:', e.message); return false; });
  push.pushing = false;
  if (!sent) return void fallback(receipt, push);
  push.pushes = 2;
  push.at = Date.now();
  log('pushed again', push.card, receipt);
}

/** The second push missed too: type the answer into the session's own pane, or say on the card that it was not seen. */
async function fallback(receipt: string, push: Push): Promise<void> {
  if (!pending.delete(receipt)) return;
  if (pane) {
    try {
      await typeIntoOwnPane(pane, push.body);
      log('typed the answer into pane', pane, 'for', push.card);
      void inbox.ack(push.card).then(() => { log('read', push.card); void clearNotSeen(push.card); }, (e: Error) => log('ack failed:', e.message));
      return;
    } catch (e) {
      log('no herdr send for', push.card, '-', (e as Error).message);
      return markNotSeen(push.card, (e as Error).message);
    }
  }
  await markNotSeen(push.card, channelOff ? 'its channel is off' : 'channel dropped it twice');
}

/** Type the answer into this session's own pane, under the rule an approval follows: never over a draft the person
 * is typing, and never into a pane without an input box. The reason is short because a card's status is 60 characters. */
async function typeIntoOwnPane(at: string, text: string): Promise<void> {
  let exists = false;
  try { exists = Boolean((JSON.parse(await runHerdr('pane', 'get', at)) as { result?: { pane?: unknown } }).result?.pane); } catch { exists = false; }
  if (!exists) throw new Error(`herdr has no pane ${at}`);
  const box = boxState(await runHerdr('pane', 'read', at, '--lines', '40', '--source', 'visible', '--format', 'ansi'));
  if (box.state === 'NO-BOX') throw new Error('the pane shows no input box');
  if (box.state === 'DRAFT') throw new Error('the pane holds a draft');
  await runHerdr('agent', 'prompt', at, text);
}

async function markNotSeen(card: string, reason: string): Promise<void> {
  const label = `Not seen by the agent: ${reason}`;
  notSeen.set(card, label);
  log('not seen:', card, reason);
  try { await inbox.status(card, label); } catch (e) { log('status failed:', (e as Error).message); }
}

/** Once the answer does arrive another way, such as a force-send, the card stops saying it was not seen. */
async function clearNotSeen(card: string): Promise<void> {
  const label = notSeen.get(card);
  if (label === undefined) return;
  notSeen.delete(card);
  try {
    const { card: current } = await inbox.get(card);
    if (current.status === label) await inbox.status(card, '');
  } catch { /* the card is gone, or a revision owns its status now */ }
}

const stop = new AbortController();
const quit = (): void => { stop.abort(); process.exit(0); };
// Exit with the session: a leftover server would show the agent as listening.
process.stdin.on('end', quit);
process.stdin.on('close', quit);
mcp.onclose = quit;

await mcp.connect(new StdioServerTransport());
transcript = findTranscript();
offset = transcriptSize();
setInterval(scanTranscript, Math.min(500, Math.max(50, Math.floor(RETRY_MS / 4))));
log('connected to', inbox.url, 'as', agent, channelOff ? '(channel off: the session started without the development-channels flag)' : '');

void inbox.stream(agent, async (ev) => {
  if (ev.type === 'guidance') {
    await notify(`The person approved new card guidance, version ${ev.guidance.version}. Follow it from now on:\n${ev.guidance.text}`, { guidance: String(ev.guidance.version) });
    return;
  }
  if (ev.type === 'returned') {
    await notify(describeReturned(ev), { card_id: ev.card.id });
    return;
  }
  if (ev.type !== 'answer') return;
  const { card, answer } = ev;
  const dismissed = card.dialog ? await closeOwnDialog(card.origin?.herdrPane) : false;
  const receipt = ev.id;
  const head = card.dialog
    ? `The person answered your AskUserQuestion in the inbox. Treat this as their answer${dismissed ? ' and ignore the cancelled dialog' : ''}:`
    : `The person answered card "${card.title}":`;
  const urgency = answer.delivery === 'force' ? ' They force-sent it: act on it now.' : '';
  const body = card.kind === 'secret' ? await secrets.receive(card, answer) : `${head}${urgency}\n${describeAnswer(card, answer, await saveAnswerImages(inbox, agent, answer))}`;
  // A newer answer to the same card replaces the one the channel is still trying to deliver.
  for (const [older, push] of pending) if (push.card === card.id) pending.delete(older);
  const push: Push = { card: card.id, body, meta: { card_id: card.id, receipt }, at: Date.now(), pushing: true, pushes: 1 };
  pending.set(receipt, push);
  try {
    await notify(body, push.meta);
    push.at = Date.now();
    log('pushed', card.id, receipt);
  } catch (e) {
    log('push failed:', (e as Error).message);
  } finally {
    push.pushing = false;
  }
}, stop.signal, 'auto', { channelOff }).catch((e: Error) => log('stream stopped:', e.message));
