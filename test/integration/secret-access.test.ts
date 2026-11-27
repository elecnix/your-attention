// A secret_access card end to end on a real serve, with a stand-in source: the lookup, card_post, the owner's grant,
// the sealed value on the agent stream, and the revoke event. SPEC.md#secret-sources holds the contract.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import type { AccessGrant, Candidate, SecretSources, SourceInfo } from '../../src/core/secret-sources.ts';
import { openSealed, sealValue } from '../../src/core/sealed.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { start, until, type Harness } from './harness.ts';

const SOURCES: SourceInfo[] = [{ instance: 'test-machine', name: 'stand-in', builtin: false, status: 'ready' }];
const CANDIDATE: Candidate = { id: 'demo', label: 'Demo key', source: 'stand-in', instance: 'test-machine', type: 'api-key', host: 'api.example.test' };
const VALUE = 'demo-key-not-real';

const standIn: SecretSources = {
  list: async () => SOURCES,
  lookup: async (q) => ({ candidates: q.host === 'api.example.test' ? [CANDIDATE] : [], sources: SOURCES }),
  release: async (_source, candidate, publicKey) => {
    if (candidate !== 'demo') throw new Error('no such item');
    return sealValue(publicKey, VALUE);
  },
};

let h: Harness;
before(async () => { h = await start({ secretSources: standIn }); });
after(async () => { await h.stop(); });

describe('secret_access on the laptop server', () => {
  it('looks up, posts with card_post, grants, delivers the sealed value, and revokes', async () => {
    const client = new Client({ url: h.server.url, token: h.agentToken });
    const found = await client.secretLookup({ host: 'api.example.test' });
    assert.deepEqual(found, { candidates: [CANDIDATE], sources: SOURCES });

    const listener = h.listen(client, 'sa-1');
    await until(async () => (await h.stored()).presence['sa-1']?.online);
    const secrets = new SecretRequests();
    const ctx = { inbox: client, secrets, agent: 'sa-1', origin: async () => undefined, arrival: 'later' };
    const said = await runTool(ctx, 'card_post', { id: 'sa-card', title: 'Use the demo key?', body: 'root = Card([key])\nkey = widget secret_access {"name": "DEMO_API_KEY", "query": {"type": "api-key", "host": "api.example.test"}}' });
    assert.match(said, /Posted card sa-card/);

    // The agent cannot grant its own card.
    const until1h = Date.now() + 3_600_000;
    const choice = { grant: 'demo', source: 'stand-in', instance: 'test-machine', until: until1h };
    const forged = await fetch(`${h.server.url}/v1/cards/sa-card/answer`, { method: 'POST', headers: { authorization: `Bearer ${h.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: { DEMO_API_KEY: choice } }) });
    assert.equal(forged.status, 403);

    const res = await h.owner('POST', '/v1/cards/sa-card/answer', { values: { DEMO_API_KEY: choice } });
    assert.equal(res.status, 200);
    const ev = await until(() => listener.events.find((e) => e.type === 'answer' && e.card.id === 'sa-card'));
    assert.ok(ev.type === 'answer');
    const g = ev.answer.values['DEMO_API_KEY'] as AccessGrant;
    assert.equal(g.until, until1h);
    const key = (secrets as unknown as { keys: Map<string, CryptoKey[]> }).keys.get('sa-card')![0]!;
    assert.equal(await openSealed(key, g.sealed), VALUE);

    assert.equal((await fetch(`${h.server.url}/v1/cards/sa-card/revoke`, { method: 'POST', headers: { authorization: `Bearer ${h.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ field: 'DEMO_API_KEY' }) })).status, 403);
    assert.equal((await h.owner('POST', '/v1/cards/sa-card/revoke', { field: 'DEMO_API_KEY' })).status, 200);
    const revoke = await until(() => listener.events.find((e) => e.type === 'revoke'));
    assert.ok(revoke.type === 'revoke');
    assert.equal(revoke.card.id, 'sa-card');
    assert.equal(revoke.field, 'DEMO_API_KEY');
    assert.equal(revoke.case, g.case);
    listener.stop();
  });
});
