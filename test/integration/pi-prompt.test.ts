// The pi extension turns each prompt span a session waits on into one blocked card, and types an answer from the card
// into that session's own pane.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yourAttention from '../../src/integrations/pi/extension.ts';
import type { Card } from '../../src/core/types.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
const savedPane = process.env['HERDR_PANE_ID'];
const savedBin = process.env['HERDR_BIN_PATH'];
before(async () => { h = await start(); process.env['YOUR_ATTENTION_HOME'] = h.home; });
after(async () => {
  // The last session's stream keeps retrying a closed inbox, so it is shut down before the inbox goes.
  await handlers.get('session_shutdown')?.({}, ctx);
  await h.stop();
  delete process.env['YOUR_ATTENTION_HOME'];
  if (savedPane === undefined) delete process.env['HERDR_PANE_ID']; else process.env['HERDR_PANE_ID'] = savedPane;
  if (savedBin === undefined) delete process.env['HERDR_BIN_PATH']; else process.env['HERDR_BIN_PATH'] = savedBin;
});

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler>();
const tools = new Map<string, unknown>();
const sent: string[] = [];
// Each test runs its own session, so one test's cards stay out of the next one's queue.
let session = '';
const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => session, getCwd: () => '/repo', getSessionName: () => 'card inbox' } };
const pi = {
  on: (name: string, fn: Handler) => { handlers.set(name, fn); },
  registerTool: (t: { name: string }) => { tools.set(t.name, t); },
  sendUserMessage: (text: string) => { sent.push(text); },
};

const PROMPT_SCREEN = [
  '╭──────────────────────────────────────╮',
  '│ Pick a database                      │',
  '│ ❯ SQLite                             │',
  '│   Postgres                           │',
  '╰──────────────────────────────────────╯',
].join('\n');

/** A herdr that logs each command, reads its screen from a file the test writes, and clears that file when a key goes
 * out, the way a prompt closes on the answer it took. */
function fakeHerdr(): { bin: string; screen(screen: string): void; calls(): string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-pi-prompt-'));
  const screen = path.join(dir, 'screen');
  const log = path.join(dir, 'calls');
  fs.writeFileSync(screen, PROMPT_SCREEN);
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'herdr'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  'pane current') printf '%s' '{"result":{"pane":{"pane_id":"w7:p1","tab_id":"w7:t1","workspace_id":"w7"}}}' ;;
  'tab get') printf '%s' '{"result":{"tab":{"tab_id":"w7:t1","label":"prompt test"}}}' ;;
  'workspace get') printf '%s' '{"result":{"workspace":{"workspace_id":"w7","label":"Tests"}}}' ;;
  'pane read') cat '${screen}' ;;
  'agent send-keys') : > '${screen}' ;;
esac
exit 0
`, { mode: 0o755 });
  return {
    bin: path.join(dir, 'herdr'),
    screen: (text: string) => fs.writeFileSync(screen, text),
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

/** A session started under the environment a test gives it, with its handlers in the maps above. */
async function connect(name: string, env: { pane?: string; herdr: string }): Promise<void> {
  session = name;
  if (env.pane === undefined) delete process.env['HERDR_PANE_ID']; else process.env['HERDR_PANE_ID'] = env.pane;
  process.env['HERDR_BIN_PATH'] = env.herdr;
  handlers.clear();
  tools.clear();
  sent.length = 0;
  yourAttention(pi as never);
  await handlers.get('session_start')?.({}, ctx);
  await until(async () => ((await h.stored()) as { presence: Record<string, { online: boolean }> }).presence[`pi:${session}`]?.online);
}

const startPrompt = (kind: string, title?: string): Promise<unknown> =>
  Promise.resolve(handlers.get('ui_prompt_start')?.({ type: 'ui_prompt_start', reason: 'ui_prompt', kind, ...(title ? { title } : {}) }, ctx));
const endPrompt = (): Promise<unknown> => Promise.resolve(handlers.get('ui_prompt_end')?.({ type: 'ui_prompt_end', reason: 'ui_prompt' }, ctx));

const cards = async (): Promise<Card[]> => ((await h.stored()) as { cards: Card[] }).cards.filter((c) => c.agent === `pi:${session}`);
const oneCard = async (): Promise<Card> => until(async () => {
  const all = await cards();
  return all.length === 1 ? all[0] : undefined;
});
const closed = async (id: string): Promise<Card['closed']> => until(async () => (await cards()).find((c) => c.id === id)?.closed);

describe('a prompt a pi session waits on', () => {
  let herdr: ReturnType<typeof fakeHerdr>;
  beforeEach(async () => {
    await handlers.get('session_shutdown')?.({}, ctx);
    herdr = fakeHerdr();
  });

  // The fake herdr is a shell script, so these two exercise the wiring on a POSIX host only; the place parsing itself
  // is covered by the unit test, which injects the Herdr function.
  it('posts one blocked card that names the session, the prompt and its pane', { skip: process.platform === 'win32' ? 'the fake herdr is a shell script' : false }, async () => {
    await connect('pi-prompt-1', { pane: 'w7:p1', herdr: herdr.bin });
    await startPrompt('select', 'Pick a database');
    const card = await oneCard();
    assert.equal(card.kind, 'blocked');
    assert.equal(card.priority, 'now');
    assert.equal(card.title, 'card inbox is waiting for you');
    assert.match(card.text ?? '', /card inbox \(pi-prompt-1\) is waiting at the select prompt: "Pick a database"\./);
    assert.match(card.text ?? '', /types it into the pane/);
    assert.equal(card.options, undefined, 'the prompt labels never reach the extension, so the card offers none');
    // A blocked card keeps the default delivery: `none` would keep the answer from the one integration that types it.
    assert.equal(card.deliver, 'stream');
    assert.equal(card.origin?.herdrPane, 'w7:p1');
    assert.equal(card.origin?.herdrWorkspace, 'Tests');
    assert.equal(card.origin?.herdrTab, 'prompt test');
  });

  it('posts one card for two overlapping prompts', async () => {
    await connect('pi-prompt-2', { pane: 'w7:p1', herdr: herdr.bin });
    await startPrompt('select', 'Pick a database');
    await oneCard();
    await startPrompt('input', 'Name the cache');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await cards()).length, 1);
  });

  it('closes the card as answered in the terminal when the prompt ends', async () => {
    await connect('pi-prompt-3', { pane: 'w7:p1', herdr: herdr.bin });
    await startPrompt('confirm', 'Run the tests?');
    const card = await oneCard();
    await endPrompt();
    assert.equal((await closed(card.id))?.kind, 'answered-in-terminal');
  });

  it('types an answer from the card into the session pane once, closes as resolved, and leaves the model out', { skip: process.platform === 'win32' ? 'the fake herdr is a shell script' : false }, async () => {
    await connect('pi-prompt-4', { pane: 'w7:p1', herdr: herdr.bin });
    await startPrompt('select', 'Pick a database');
    const card = await oneCard();
    await h.owner('POST', `/v1/cards/${card.id}/answer`, { comment: 'SQLite' });
    assert.equal((await closed(card.id))?.kind, 'resolved');
    const keys = herdr.calls().filter((c) => c.startsWith('agent send-keys'));
    assert.deepEqual(keys, ['agent send-keys w7:p1 SQLite']);
    assert.ok(!sent.some((m) => m.includes(card.id)), 'the model is asked nothing about the answer the prompt already took');
  });

  it('refuses an answer to a prompt that changed, and types nothing', async () => {
    await connect('pi-prompt-5', { pane: 'w7:p1', herdr: herdr.bin });
    await startPrompt('select', 'Pick a database');
    const card = await oneCard();
    herdr.screen('╭──────────────────────────╮\n│ Which region?            │\n╰──────────────────────────╯');
    await h.owner('POST', `/v1/cards/${card.id}/answer`, { comment: 'SQLite' });
    const outcome = (await closed(card.id))?.outcome ?? '';
    assert.match(outcome, /changed or closed/);
    assert.deepEqual(herdr.calls().filter((c) => c.startsWith('agent send-keys')), [], 'no keystroke lands on a prompt that moved on');
  });

  it('posts an informational card without a pane, and refuses an answer on it', async () => {
    await connect('pi-prompt-nopane', { herdr: herdr.bin });
    await startPrompt('input', 'Name the cache');
    const card = await oneCard();
    assert.equal(card.origin?.herdrPane, undefined);
    assert.match(card.text ?? '', /runs outside a herdr pane/);
    await h.owner('POST', `/v1/cards/${card.id}/answer`, { comment: 'shared' });
    const outcome = (await closed(card.id))?.outcome ?? '';
    assert.match(outcome, /no herdr pane/);
    assert.deepEqual(herdr.calls().filter((c) => c.startsWith('agent send-keys')), []);
  });
});
