// An agent that was offline when the person approved new card guidance gets that guidance when it reconnects: the
// inbox's hello carries the current version, and the client fetches the text when the version is newer than the one
// it knew. card_guidance reads the current version at any time.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

describe('guidance for an agent that was offline', () => {
  it('arrives as a guidance event when the agent reconnects after the approval', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const first = h.listen(client, 's-away');
    await until(() => first.events.find((e) => e.type === 'hello'));
    first.stop();
    await first.ended;
    const card = await client.proposeGuidance('Always attach a screenshot.', 's-other');
    await h.owner('POST', `/v1/cards/${card.id}/answer`, { values: { choice: 'approve', agents: [] } });
    const second = h.listen(client, 's-away');
    const ev = await until(() => second.events.find((e) => e.type === 'guidance'));
    assert.ok(ev.type === 'guidance');
    assert.equal(ev.guidance.text, 'Always attach a screenshot.');
    second.stop();
  });

  it('does not repeat the guidance on a reconnect when the version has not changed', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const first = h.listen(client, 's-steady');
    await until(() => first.events.find((e) => e.type === 'hello'));
    first.stop();
    await first.ended;
    const second = h.listen(client, 's-steady');
    await until(() => second.events.find((e) => e.type === 'hello'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(second.events.filter((e) => e.type === 'guidance').length, 0);
    second.stop();
  });
});
