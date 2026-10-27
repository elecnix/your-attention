import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { isSealed, newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { seal } from '../../web/sealed.js';

const agent: Caller = { token: 'ta', role: 'agent' };

describe('sealed secrets', () => {
  it('opens what the page sealed, and only with the key that asked', async () => {
    const keys = await newSealKeys();
    const sealed = await seal(keys.publicKey, 'sk-example-not-real');
    assert.ok(isSealed(sealed));
    assert.doesNotMatch(JSON.stringify(sealed), /sk-example/);
    assert.equal(await openSealed(keys.privateKey, sealed), 'sk-example-not-real');
    const other = await newSealKeys();
    await assert.rejects(openSealed(other.privateKey, sealed));
  });

  it('requires a name and a public key on a secret card', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const { publicKey } = await newSealKeys();
    assert.throws(() => inbox.postCard(agent, { agent: 's1', kind: 'secret', title: 'Key?' }), /secret/);
    assert.throws(() => inbox.postCard(agent, { agent: 's1', kind: 'secret', title: 'Key?', secret: { name: 'bad name', publicKey } }), /name/);
    const card = inbox.postCard(agent, { agent: 's1', kind: 'secret', title: 'Key?', secret: { name: 'OLLAMA_API_KEY', publicKey } });
    assert.equal(card.secret?.name, 'OLLAMA_API_KEY');
  });

  it('stores only a sealed value, never plain text', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const keys = await newSealKeys();
    inbox.postCard(agent, { id: 'k1', agent: 's1', kind: 'secret', title: 'Key?', secret: { name: 'API_KEY', publicKey: keys.publicKey } });
    await assert.rejects(inbox.answer('k1', { values: { secret: 'plain' } }), /sealed/);
    await assert.rejects(inbox.answer('k1', { values: { sealed: 'plain' } }), /sealed/);
    const sealed = await seal(keys.publicKey, 'value');
    const a = await inbox.answer('k1', { values: { sealed } });
    assert.ok(isSealed(a.values['sealed']));
    const declined = await inbox.answer('k1', { comment: 'Use the staging key instead.' });
    assert.deepEqual(declined.values, {});
  });

  it('keeps sealed values out of search', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const keys = await newSealKeys();
    inbox.postCard(agent, { id: 'k1', agent: 's1', kind: 'secret', title: 'Key?', secret: { name: 'API_KEY', publicKey: keys.publicKey } });
    const sealed = await seal(keys.publicKey, 'value');
    await inbox.answer('k1', { values: { sealed } });
    assert.equal(inbox.search(sealed.data.slice(0, 12)).length, 0);
  });
});
