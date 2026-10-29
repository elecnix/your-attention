// An agent may revise a card the person already answered or that is closed. The card stays in the person's Sent list,
// so the person is not told and won't answer it again, and the agent hears that with the revision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { serve } from '../../src/node/server.ts';
import { runTool, type ToolContext } from '../../src/integrations/run-tool.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-sent-edit-'));
const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report', blocked: 'a test inbox sends nothing' } });
after(async () => { await server.close(); fs.rmSync(home, { recursive: true, force: true }); });
const agent = new Client({ url: server.url, token: fs.readFileSync(path.join(home, 'agent-token'), 'utf8').trim() });
const owner = {
  answer: async (id: string, body: unknown) => {
    const res = await fetch(`${server.url}/v1/cards/${id}/answer`, { method: 'POST', headers: { authorization: `Bearer ${server.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.ok, true, await res.text());
  },
};

describe('revising a sent card', () => {
  it('saves the revision of an answered card and warns that the person will not see it or answer again', async () => {
    await agent.post({ id: 'c1', agent: 's1', title: 'Merge it?', text: 'Old text.' });
    assert.equal((await agent.post({ id: 'c1', agent: 's1', title: 'Merge it?', text: 'Still open.' })).warning, undefined);
    await owner.answer('c1', { comment: 'Yes.' });
    const revised = await agent.post({ id: 'c1', agent: 's1', title: 'Merge it?', text: 'New text.' });
    assert.equal(revised.text, 'New text.');
    assert.match(revised.warning ?? '', /already answered/);
    assert.match(revised.warning ?? '', /not notified/);
    assert.match(revised.warning ?? '', /won't answer it again/);
    assert.match(revised.warning ?? '', /follows: "c1"/);
    const patched = await agent.patch('c1', [{ old: 'New', new: 'Newer' }]);
    assert.equal(patched.text, 'Newer text.');
    assert.match(patched.warning ?? '', /already answered/);
  });

  it('warns for a closed card too', async () => {
    await agent.post({ id: 'c2', agent: 's1', title: 'Ship it?' });
    await agent.close('c2', 'resolved', 'Shipped.');
    assert.match((await agent.post({ id: 'c2', agent: 's1', title: 'Ship it?', text: 'Again.' })).warning ?? '', /closed/);
  });

  it('passes the warning to the agent in the tool reply', async () => {
    const ctx = { inbox: agent, agent: 's1', arrival: 'in this session', origin: async () => undefined } as unknown as ToolContext;
    await runTool(ctx, 'card_post', { id: 'c3', title: 'Rename it?' });
    await owner.answer('c3', { comment: 'No.' });
    const reply = await runTool(ctx, 'card_patch', { card_id: 'c3', edits: [{ old: 'Rename', new: 'Really rename' }], field: 'title' });
    assert.match(reply, /version 2/);
    assert.match(reply, /already answered/);
    assert.match(await runTool(ctx, 'card_post', { id: 'c3', title: 'Really rename it now?' }), /already answered/);
  });
});
