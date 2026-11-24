// The herdr sidecar turns a blocked agent's dialog into a card, and presses the answered choice in that pane only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { Card } from '../../src/core/types.ts';
import { createSidecar, type Herdr } from '../../src/integrations/herdr/blocked.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

const dialog = (marked: number, command = 'rm -rf build') => [
  ' Bash command', `   ${command}`, '',
  ' Do you want to proceed?',
  ...['Yes', "Yes, and don't ask again for rm commands", 'No, and tell Claude what to do differently (esc)'].map((l, i) => ` ${i + 1 === marked ? '❯' : ' '} ${i + 1}. ${l}`),
].join('\n');

/** A herdr with one agent, whose screen a test script changes as keys arrive. */
function fakeHerdr(pane: string, onKey: (key: string, pane: { screen: string; status: string }) => void) {
  const state = { screen: dialog(1), status: 'blocked' };
  const keys: string[] = [];
  const herdr: Herdr = async (...args) => {
    if (args[0] === 'agent' && args[1] === 'list') return JSON.stringify({ result: { agents: [{ pane_id: pane, tab_id: 't1', agent: 'claude', agent_status: state.status }] } });
    if (args[0] === 'tab' && args[1] === 'list') return JSON.stringify({ result: { tabs: [{ tab_id: 't1', label: 'fix the build' }] } });
    if (args[0] === 'pane' && args[1] === 'read') return state.screen;
    if (args[0] === 'agent' && args[1] === 'send-keys') { assert.equal(args[2], pane, 'keys go to the card pane only'); keys.push(args[3] ?? ''); onKey(args[3] ?? '', state); return '{}'; }
    throw new Error(`unexpected herdr ${args.join(' ')}`);
  };
  return { herdr, state, keys };
}

const cardFor = async (pane: string): Promise<Card> => until(async () => ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.origin?.herdrPane === pane));
const closedOutcome = async (id: string): Promise<string> => until(async () => ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.id === id)?.closed?.outcome);

describe('the herdr sidecar', () => {
  it('offers the dialog choices and presses the one you picked, with no Enter when the number acts alone', async () => {
    const fake = fakeHerdr('w1:p1', (key, s) => { if (key === '1') { s.screen = 'Running rm -rf build…'; s.status = 'working'; } });
    const sidecar = createSidecar(new Client({ url: h.server.url, token: h.agentToken }), fake.herdr, 50);
    try {
      await sidecar.tick();
      const card = await cardFor('w1:p1');
      assert.equal(card.title, 'fix the build is waiting for you');
      assert.equal(card.text, 'Do you want to proceed?');
      assert.deepEqual(card.options?.map((o) => o.label), ['Yes', "Yes, and don't ask again for rm commands", 'No, and tell Claude what to do differently (esc)']);
      await h.owner('POST', `/v1/cards/${card.id}/answer`, { values: { choice: 'o1' }, version: card.version });
      assert.equal(await closedOutcome(card.id), 'Pressed "Yes" in its session.');
      assert.deepEqual(fake.keys, ['1']);
    } finally { sidecar.stop(); }
  });

  it('presses Enter after the number when the number only moved the selection', async () => {
    const fake = fakeHerdr('w1:p2', (key, s) => { if (key === '3') s.screen = dialog(3); if (key === 'enter') { s.screen = 'Cancelled.'; s.status = 'idle'; } });
    const sidecar = createSidecar(new Client({ url: h.server.url, token: h.agentToken }), fake.herdr, 50);
    try {
      await sidecar.tick();
      const card = await cardFor('w1:p2');
      await h.owner('POST', `/v1/cards/${card.id}/answer`, { values: { choice: 'o3' }, version: card.version });
      await closedOutcome(card.id);
      assert.deepEqual(fake.keys, ['3', 'enter']);
    } finally { sidecar.stop(); }
  });

  it('presses nothing when another dialog replaced the one you answered', async () => {
    const fake = fakeHerdr('w1:p3', () => {});
    fake.state.screen = `   rm -rf dist\n${dialog(1)}`;
    const sidecar = createSidecar(new Client({ url: h.server.url, token: h.agentToken }), fake.herdr, 50);
    try {
      await sidecar.tick();
      const card = await cardFor('w1:p3');
      // The same choices, for another command whose line already showed above the first prompt.
      fake.state.screen = `   rm -rf dist\n${dialog(1, 'rm -rf dist')}`;
      await h.owner('POST', `/v1/cards/${card.id}/answer`, { values: { choice: 'o1' }, version: card.version });
      assert.match(await closedOutcome(card.id), /changed before your answer arrived/);
      assert.deepEqual(fake.keys, []);
    } finally { sidecar.stop(); }
  });

  it('presses the choice of a dialog with a blank line inside it', async () => {
    const fake = fakeHerdr('w1:p5', (key, s) => { if (key === '1') { s.screen = 'Done.'; s.status = 'working'; } });
    fake.state.screen = ' Deploy to staging?\n\n Version 4 is ready.\n ❯ 1. Deploy\n   2. Wait';
    const sidecar = createSidecar(new Client({ url: h.server.url, token: h.agentToken }), fake.herdr, 50);
    try {
      await sidecar.tick();
      const card = await cardFor('w1:p5');
      await h.owner('POST', `/v1/cards/${card.id}/answer`, { values: { choice: 'o1' }, version: card.version });
      assert.equal(await closedOutcome(card.id), 'Pressed "Deploy" in its session.');
      assert.deepEqual(fake.keys, ['1']);
    } finally { sidecar.stop(); }
  });

  it('keeps the card version when a restarted sidecar finds the same dialog', async () => {
    const fake = fakeHerdr('w1:p4', () => {});
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const first = createSidecar(client, fake.herdr, 50);
    await first.tick();
    const card = await cardFor('w1:p4');
    first.stop();
    const second = createSidecar(client, fake.herdr, 50);
    try {
      await second.tick();
      await second.tick();
      assert.equal((await cardFor('w1:p4')).version, card.version);
    } finally { second.stop(); }
  });

  it('posts no second card for a question that a verdict has not closed, such as one still in triage', async () => {
    const fake = fakeHerdr('w1:p9', () => {});
    const client = new Client({ url: h.server.url, token: h.agentToken });
    // A triage connection that never sends a verdict keeps the plugin's dialog card in triage.
    const token = fs.readFileSync(path.join(h.home, 'extension-token'), 'utf8').trim();
    const ctl = new AbortController();
    const stream = await fetch(`${h.server.url}/v1/extensions/stream?name=triage&hooks=card.created&policy=fail-open&timeoutMs=120000&screen=new`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
    try {
      await client.post({ id: 'ask-triage-1', agent: 'claude:q', dialog: true, title: 'A question', origin: { herdrPane: 'w1:p9' } });
      const states = async () => (await h.stored()) as { states: Record<string, string> };
      await until(async () => (await states()).states['ask-triage-1'] === 'in-triage' || undefined);
      const sidecar = createSidecar(client, fake.herdr, 50);
      try {
        await sidecar.tick();
        const cards = ((await h.stored()) as { cards: Card[] }).cards.filter((c) => c.origin?.herdrPane === 'w1:p9');
        assert.deepEqual(cards.map((c) => c.kind), ['ask'], 'the question under triage is present, so no blocked card joins it');
        assert.equal((await states()).states['ask-triage-1'], 'in-triage');
      } finally { sidecar.stop(); }
    } finally {
      ctl.abort();
      void stream.body?.cancel().catch(() => {});
    }
  });
});
