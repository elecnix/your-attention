// The Claude Code channel asks an inactive session for a card at 2, 5 and 10 minutes of the schedule, timed from the
// stretch the Stop hook writes. A minute lasts 200 ms here, so the asks land at 400, 1000 and 2000 ms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callAt, ROOT, start, until, type Harness } from './harness.ts';

const MINUTE = 200;
const SESSION = 'card-asks-1';
let h: Harness;
let mcp: McpClient;
const asks: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let file: string;
const write = (s: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s)); };
const read = (): { since: number; asks: number; ours?: boolean } | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

async function channel(): Promise<McpClient> {
  const client = new McpClient({ name: 'test', version: '1' });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel' && String((n.params as { content: string }).content).includes('no open card')) asks.push(Date.now());
  };
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-channel'],
    env: { ...process.env, YOUR_ATTENTION_HOME: h.home, HOME: h.home, USERPROFILE: h.home, CLAUDE_CODE_SESSION_ID: SESSION, HERDR_PANE_ID: '', YOUR_ATTENTION_REQUIRE_CARD: '1', YOUR_ATTENTION_CARD_ASK_MINUTE_MS: String(MINUTE) } as Record<string, string>,
    stderr: 'ignore',
  }));
  // Claude Code makes a request once it is connected, which is when the channel starts to push.
  await client.listTools();
  return client;
}

before(async () => {
  h = await start();
  file = path.join(h.home, 'claude', `${SESSION}.card-ask`);
  mcp = await channel();
});
after(async () => {
  await mcp.close();
  await h.stop();
});

/** The turn an ask started ends without a card, as the Stop hook records it. */
const askAnswered = () => { const s = read()!; assert.equal(s.ours, true, 'the ask marks the turn it starts'); write({ since: s.since, asks: s.asks }); };

describe('the channel asks an inactive session for a card', () => {
  it('asks at 2, 5 and 10 minutes from when the turn ended, then stops', async () => {
    asks.length = 0;
    const since = Date.now();
    write({ since, asks: 0 });
    await sleep(MINUTE * 1.5);
    assert.equal(asks.length, 0, 'nothing before two minutes');
    await until(() => asks.length === 1 || undefined, 5000);
    askAnswered();
    await until(() => asks.length === 2 || undefined, 5000);
    askAnswered();
    await until(() => asks.length === 3 || undefined, 5000);
    askAnswered();
    const minutes = asks.map((t) => (t - since) / MINUTE);
    assert.ok(minutes[0]! >= 2 && minutes[0]! < 4, `the first ask at 2 minutes, not ${minutes[0]}`);
    assert.ok(minutes[1]! >= 5 && minutes[1]! < 7, `the second ask at 5 minutes from the start, not ${minutes[1]}`);
    assert.ok(minutes[2]! >= 10 && minutes[2]! < 12, `the third ask at 10 minutes from the start, not ${minutes[2]}`);
    await sleep(MINUTE * 4);
    assert.equal(asks.length, 3, 'no fourth ask');
    fs.rmSync(file, { force: true });
  });

  it('cancels the asks when the person sends the session a card', async () => {
    asks.length = 0;
    write({ since: Date.now(), asks: 0 });
    await sleep(MINUTE);
    const res = await h.owner('POST', '/v1/send', { agent: `claude:${SESSION}`, text: 'Carry on with the migration.' });
    assert.equal(res.status, 201);
    await until(() => !fs.existsSync(file) || undefined);
    await sleep(MINUTE * 6);
    assert.equal(asks.length, 0);
  });

  it('ends the stretch once the session holds an open card', async () => {
    asks.length = 0;
    // A card the session posted without the channel, such as from the CLI, is found when the ask comes due.
    const posted = await callAt(h.server.url, h.agentToken, 'POST', '/v1/cards', { id: 'asks-open', agent: `claude:${SESSION}`, title: 'Working on the migration' });
    assert.equal(posted.status, 201);
    write({ since: Date.now(), asks: 0 });
    await until(() => !fs.existsSync(file) || undefined, 5000);
    await sleep(MINUTE * 4);
    assert.equal(asks.length, 0, 'an open card is what the asks are for');
    await callAt(h.server.url, h.agentToken, 'POST', '/v1/cards/asks-open/close', { kind: 'retracted', outcome: 'Posted only for this test.' });
  });

  it('carries a stretch under way across a channel restart', async () => {
    asks.length = 0;
    await mcp.close();
    const since = Date.now() - MINUTE * 3;
    // The 2 minute ask went out before the restart.
    write({ since, asks: 1 });
    mcp = await channel();
    await until(() => asks.length === 1 || undefined, 5000);
    const minute = (asks[0]! - since) / MINUTE;
    assert.ok(minute >= 5 && minute < 7, `the restarted channel asks at 5 minutes, not ${minute}`);
    assert.deepEqual(read(), { since, asks: 2, ours: true });
  });
});
