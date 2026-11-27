// Loads the pi extension against a stand-in for pi's ExtensionAPI.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import os from 'node:os';
import yourAttention from '../../src/integrations/pi/extension.ts';
import type { Card } from '../../src/core/types.ts';
import { seal } from '../../web/sealed.js';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
// A minute of the ask schedule lasts 100 ms here, so the asks land at 200, 500 and 1000 ms.
const MINUTE = 100;
process.env['YOUR_ATTENTION_CARD_ASK_MINUTE_MS'] = String(MINUTE);
// A card's origin takes the herdr pane from the environment of the process that posts it. These tests run the extension
// in this process, so the pane of the terminal that runs the tests would reach the inbox, and herdr with it.
const savedPane = process.env['HERDR_PANE_ID'];
delete process.env['HERDR_PANE_ID'];
before(async () => {
  h = await start();
  process.env['YOUR_ATTENTION_HOME'] = h.home;
});
after(() => {
  if (savedPane !== undefined) process.env['HERDR_PANE_ID'] = savedPane;
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
/** The name pi reports for the session, which /name changes while the session runs. */
let piName = 'card inbox';
const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => 'pi-session-1', getCwd: () => '/repo', getSessionName: () => piName } };
const pi = {
  on: (name: string, fn: Handler) => { handlers.set(name, fn); },
  registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }) => { tools.set(t.name, t); },
  sendUserMessage: (text: string, options?: { deliverAs?: string }) => { sent.push({ text, options }); },
};

/** pi's createBashTool and createLocalBashOperations as pi runs them: the spawn hook gives the environment, and the
 * operations run the command in a real bash and stream its output. */
const piTools = {
  createLocalBashOperations: () => ({
    exec: (command: string, _cwd: string, options: { onData: (d: Buffer) => void; env?: NodeJS.ProcessEnv }) => new Promise<{ exitCode: number | null }>((resolve, reject) => {
      // The session's cwd is a made-up path here, so the command runs where the test runs.
      const child = spawn('bash', ['-c', command], { env: options.env });
      child.stdout.on('data', options.onData);
      child.stderr.on('data', options.onData);
      child.on('error', reject);
      child.on('close', (exitCode) => resolve({ exitCode }));
    }),
  }),
  createBashTool: (cwd: string, options: { spawnHook: (c: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => { command: string; cwd: string; env: NodeJS.ProcessEnv }; operations: { exec: (command: string, cwd: string, o: { onData: (d: Buffer) => void; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number | null }> } }) => ({
    name: 'bash',
    async execute(_id: string, params: unknown) {
      const run = options.spawnHook({ command: (params as { command: string }).command, cwd, env: { ...process.env } });
      let text = '';
      await options.operations.exec(run.command, run.cwd, { onData: (d) => { text += String(d); }, env: run.env });
      return { content: [{ type: 'text', text }], details: undefined };
    },
  }),
};

const state = async () => (await h.stored()) as { states: Record<string, string>; presence: Record<string, { online: boolean }> };

describe('the pi extension', () => {
  it('registers the card tools and connects on session start', async () => {
    yourAttention(pi as never, async () => piTools);
    assert.deepEqual([...tools.keys()].sort(), ['card_close', 'card_guidance', 'card_patch', 'card_post', 'card_read', 'card_search', 'card_status', 'card_tag', 'card_tags', 'card_template_save', 'card_triage_feedback', 'card_widget_save', 'settings']);
    await handlers.get('session_start')?.({}, ctx);
    await until(async () => (await state()).presence['pi:pi-session-1']?.online);
  });

  it('reports where the session runs on its connection, so the inbox names the row before any card', async () => {
    // The extension puts the origin on the connection the socket carries, which is what a hosted inbox reads too.
    const row = (await h.stored()).presence['pi:pi-session-1'] as { origin?: Record<string, string> };
    assert.equal(row.origin?.['harness'], 'pi');
    assert.equal(row.origin?.['session'], 'pi-session-1');
    assert.equal(row.origin?.['name'], 'card inbox', 'the name the session reports');
    assert.equal(row.origin?.['host'], os.hostname());
  });

  it('names a card with the name the session has now, after a rename', async () => {
    piName = 'release prep';
    try {
      await tools.get('card_post')!.execute('call-r', { id: 'pi-renamed', title: 'Tag the release?', text: 'A card.' }, undefined, undefined, ctx);
      const card = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === 'pi-renamed');
      assert.equal(card?.origin?.name, 'release prep');
    } finally {
      piName = 'card inbox';
      // An open card would keep the turn-end request below from asking for one.
      await tools.get('card_close')!.execute('call-rc', { card_id: 'pi-renamed', kind: 'retracted', outcome: 'Asked only to test the name.' }, undefined, undefined, ctx);
    }
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

  it('gives each bash command the secret as $PI_KEY, masks it in the output, and writes no file', async () => {
    const res = await tools.get('card_post')!.execute('call-s', { id: 'pi-key', title: 'Need the pi key', body: 'root = Card([key])\nkey = widget secret {"name": "PI_KEY"}' }, undefined, undefined, ctx);
    assert.match(res.content[0]!.text, /Posted card pi-key/);
    const id = 'pi-key';
    const card = ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === id);
    const publicKey = JSON.parse(JSON.parse(/SecretInput\("PI_KEY", ("(?:[^"\\]|\\.)*")\)/.exec(card!.body!)![1]!)) as JsonWebKey;
    await h.owner('POST', `/v1/cards/${id}/answer`, { values: { PI_KEY: await seal(publicKey, 'pi-value-not-real') } });
    const msg = await until(() => sent.find((m) => m.text.includes(String(id))));
    assert.doesNotMatch(msg.text, /pi-value-not-real/);
    assert.match(msg.text, /PI_KEY is available to this session until .* \(case [0-9a-f]+\)\. Every command you run gets it as \$PI_KEY/);
    assert.ok(tools.has('bash'), 'the extension rebuilt the bash tool once a grant arrived');
    const out = await tools.get('bash')!.execute('call-b', { command: 'printf "%s|%s" "$PI_KEY" "${#PI_KEY}"' }, undefined, undefined, ctx);
    assert.equal(out.content[0]!.text, '[secret PI_KEY]|17');
    assert.equal(process.env['PI_KEY'], undefined, 'the value never enters the extension process environment');
    const masked = await handlers.get('tool_result')!({ toolName: 'read', content: [{ type: 'text', text: 'key=pi-value-not-real' }] }, ctx) as { content: { text: string }[] };
    assert.equal(masked.content[0]!.text, 'key=[secret PI_KEY]');
  });

  it('steers a busy agent, and queues an answer marked as a follow-up', async () => {
    idle = false;
    await tools.get('card_post')!.execute('call-2', { id: 'pi-2', title: 'Rename it?', text: 'A card.' }, undefined, undefined, ctx);
    await h.owner('POST', '/v1/cards/pi-2/answer', { comment: 'yes' });
    assert.equal((await until(() => sent.find((m) => m.text.includes('pi-2')))).options?.deliverAs, 'steer');
    await tools.get('card_post')!.execute('call-3', { id: 'pi-3', title: 'Tests too?', text: 'A card.' }, undefined, undefined, ctx);
    await h.owner('POST', '/v1/cards/pi-3/answer', { comment: 'later', delivery: 'followUp' });
    assert.equal((await until(() => sent.find((m) => m.text.includes('pi-3')))).options?.deliverAs, 'followUp');
  });
});

describe('the asks for a card', () => {
  it('asks an inactive session with no open card at 2, 5 and 10 minutes, and starts over on activity', async () => {
    idle = true;
    const asks = () => sent.filter((m) => m.text.includes('no open card'));
    const turnEnd = () => handlers.get('agent_settled')?.({}, ctx);
    const turnStart = () => handlers.get('agent_start')?.({}, ctx);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Without the opt-in nothing is asked.
    await turnEnd();
    await sleep(MINUTE * 12);
    assert.equal(asks().length, 0);
    process.env['YOUR_ATTENTION_REQUIRE_CARD'] = '1';
    try {
      // The person types, and the run settles: the stretch starts here.
      await turnStart();
      const since = Date.now();
      await turnEnd();
      await sleep(MINUTE * 1.5);
      assert.equal(asks().length, 0, 'nothing before two minutes');
      await until(() => asks().length === 1 || undefined);
      assert.equal(asks()[0]!.options, undefined, 'the ask starts a run of its own');
      // The run the ask started is the session's own: it keeps the stretch, so the next ask lands at 5 minutes.
      await turnStart();
      await turnEnd();
      await until(() => asks().length === 2 || undefined);
      const second = (Date.now() - since) / MINUTE;
      assert.ok(second >= 5 && second < 7, `the second ask at 5 minutes, not ${second}`);
      await turnStart();
      await turnEnd();
      await until(() => asks().length === 3 || undefined);
      await turnStart();
      await turnEnd();
      await sleep(MINUTE * 5);
      assert.equal(asks().length, 3, 'three asks, then nothing until the session does something');
      // Activity at 3.5 minutes of a new stretch cancels its 5 and 10 minute asks and starts a fresh one, whose first ask
      // at 5.5 minutes comes after the cancelled 5 minute ask would have.
      await turnStart();
      await turnEnd();
      await until(() => asks().length === 4 || undefined);
      await turnStart();
      await turnEnd();
      const stretchStart = Date.now() - MINUTE * 2;
      await sleep(MINUTE * 1.5);
      await turnStart();
      const restart = Date.now();
      await turnEnd();
      await until(() => asks().length === 5 || undefined);
      const fresh = (Date.now() - restart) / MINUTE;
      assert.ok(fresh >= 2 && fresh < 4, `the new stretch asks 2 minutes after its own start, not ${fresh}`);
      const old = (Date.now() - stretchStart) / MINUTE;
      assert.ok(old >= 5.5, `the old stretch's 5 minute ask was cancelled, but an ask came at ${old}`);
      // A card of its own is what the asks are for: once one is open, the stretch ends without an ask.
      await turnStart();
      await tools.get('card_post')!.execute('call-4', { id: 'pi-4', title: 'Still working?', text: 'A card.' }, undefined, undefined, ctx);
      await turnEnd();
      await sleep(MINUTE * 12);
      assert.equal(asks().length, 5);
      await h.owner('POST', '/v1/cards/pi-4/answer', { comment: 'ok' });
    } finally {
      delete process.env['YOUR_ATTENTION_REQUIRE_CARD'];
    }
  });
});
